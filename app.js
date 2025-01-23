const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { writeFileSync } = require('fs');
const { join } = require('path');

const qrcode = require('qrcode-terminal');

require('dotenv').config();

function setConsoleLog(text) {
	console.log(`============================== ${text}! ==============================`);
	return;
}

function getCompass(shorthand) {
    switch (shorthand) {
        case 'N':
            return 'Utara';
        case 'S':
            return 'Selatan';
        case 'W':
            return 'Barat';
        case 'E':
            return 'Timur';
        case 'NW':
            return 'Barat Laut';
        case 'NE':
            return 'Timur Laut';
        case 'SW':
            return 'Barat Daya';
        case 'SE':
            return 'Tenggara';
        default:
            return shorthand;
    };
}

function getDatetimeFormat(stringdate) {
    const date = stringdate.split('T')[0];
    const time = stringdate.split('T')[1].replace("Z", "");
    return `${date} ${time}`;
}

function getResponseFormat(status_code, status, response) {
    return {
        "status_code" : status_code,
        "status" : status,
        "response" : response
    };
}

async function fetchData(endpoint) {
    try {
        const request = await fetch(endpoint);
        const response = request.ok ? await request.json() : "";
        
        return getResponseFormat(request.status, request.statusText, response);

    } catch (error) {
        console.error();
        return getResponseFormat(501, "Not Implemented!", "");
    }
}

async function getWeatherPrediction(countyCode) {
    const request = await fetchData(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${countyCode}`);
    const response = request['status_code'] == 200 ? request['response'] : null;

	if (response === null) {
		return response;
	}

    const weathers = response.data[0].cuaca[0];

    const messages = [];
    for (let i = 0; i < weathers.length; i++) {
        const weather = weathers[i];
        const message = [
            `Tanggal & Waktu: ${getDatetimeFormat(weather.datetime)}`,
            `Cuaca: ${weather.weather_desc}`,
            `Suhu: ${weather.t} °C`,
            `Kelembapan: ${weather.hu} %`,
            `Kecepatan Angin: ${weather.ws} km/jam`,
            `Asal Angin: ${getCompass(weather.wd)}`,
            `Arah Angin: ${getCompass(weather.wd_to)}`
        ]

        messages.push(message.join('\n'));
    }

    return messages;
}

async function createSocket() {
	const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
	const sock = makeWASocket({ auth: state, });

	sock.ev.on('creds.update', saveCreds);
	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (connection === 'close') {
			const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
			setConsoleLog('CONNECTION CLOSED');
		
			if (shouldReconnect) {
				setConsoleLog('RECONNECTING');
				createSocket();
			}

		} else if (connection === 'open') {
			setConsoleLog('CONNECTED!');
		}

		if (qr) {
			setConsoleLog('SCAN TO AUTHENTICATE');
			qrcode.generate(qr, { small: true });
		}
	});

	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update;

		if (connection === 'close') {
			setConsoleLog('RECONNECTING');
			if (lastDisconnect?.error?.output?.statusCode === 428) {
				sock.connect();
			}

		} else if (connection === 'open') {
			setConsoleLog('RECONNECTED');
		}
	});

	sock.ev.on('messages.upsert', async (messageUpdate) => {
		setConsoleLog('NEW MESSAGES');

		if (messageUpdate.type === 'notify' && messageUpdate.messages) {
			messageUpdate.messages.forEach((message) => {
				const jid = message.key.remoteJid;

				if (jid.endsWith('@g.us')) {
					console.log('Group JID:', jid);
				} else {
					console.log('Individual JID:', jid);
				}
			});
		}
	});

	const sendMessageToGroup = async (groupJid, message) => {
		try {
			await sock.sendMessage(groupJid, { text: message });
			setConsoleLog('MESSAGE SENT');
			console.log('Message sent to group:', groupJid);
		} catch (error) {
			setConsoleLog('ERROR');
			console.error('Error sending message:', error);
		}
	};

	setInterval(async () => {
		const message = await getWeatherPrediction(process.env.WA_COUNTY_CODE);
		if (message !== null) {
			sendMessageToGroup(process.env.WA_GROUP_ID, message.join('\n\n'));
		}

	}, 60000);
}

createSocket();