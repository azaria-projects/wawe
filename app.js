const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { writeFileSync } = require('fs');
const { join } = require('path');
const { makeInMemoryStore } = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

const store = makeInMemoryStore({});

var isReconnecting = false;
var isConnected = false;
var connectionDelay = 0;

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

function getWeatherEmot(weatherNumber) {
	switch (weatherNumber) {
		case 1:
			return '☀';
		case 61:
			return '🌦';
		case 2:
			return '🌤';																																																																										
		default:
			return '🌧';
	}
}

function getDatetimeFormat(stringdate) {
    const date = stringdate.split('T')[0];
    const time = stringdate.split('T')[1].replace("Z", "");
    return `${date} ${time}`;
}

function getDateFormat(date) {
	return new Intl.DateTimeFormat(
		'id-ID', 
		{ 
			weekday: 'long', 
			day: 'numeric', 
			month: 'long', 
			year: 'numeric' 
		}
	).format(new Date(date));
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

    const weathers = response.data[0].cuaca[1].concat(response.data[0].cuaca[2].slice(0, 3)).slice(2);
	const currentDate = `📑 ${getDateFormat(weathers[0].datetime.split('T')[0])}`;
	const currentTimezone = 'WIB';

    const messages = [];
	messages.push(currentDate);

    for (let i = 0; i < weathers.length; i++) {
        const weather = weathers[i];
        const message = [
            `${weather.datetime.split('T')[1].replace("Z", "")} ${currentTimezone}`,
            `*${getWeatherEmot(weather.weather)} ${weather.weather_desc} / ${weather.t} °C*\n`,
            `Kelembapan : ${weather.hu} %`,
            `Asal Angin : ${getCompass(weather.wd)}`,
            `Arah Angin : ${getCompass(weather.wd_to)}`,
			`Kecepatan : ${weather.ws} km/jam`
        ];
		
        messages.push(message.join('\n'));
    }

    return messages;
}

async function createSocket() {
	const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
	const sock = makeWASocket({ auth: state, });	

	store.readFromFile('./session.json');
	store.bind(sock.ev);

	const reconnectWithBackoff = async (attempt = 1) => {
		connectionDelay = Math.min(30, Math.pow(2, attempt)) * 1000;
		setConsoleLog(`RETRYING CONNECTION TO AUTHENTICATE IN ${connectionDelay / 1000} SECONDS`);

		await new Promise(resolve => setTimeout(resolve, connectionDelay));
		
		connectionDelay = 0;
		return createSocket();
	};

	sock.ev.on('creds.update', saveCreds);

	sock.ev.on('connection.error', (error) => {
		setConsoleLog('CONNECTION ERROR');
		console.error('WebSocket Connection Error:', error);
	});

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr) {
			setConsoleLog('SCAN TO AUTHENTICATE');
			qrcode.generate(qr, { small: true });
		}

		if (connection === 'close') {
			isConnected = false;
			const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
			setConsoleLog('CONNECTION CLOSED');
			if (shouldReconnect && isReconnecting !== true) {
				isReconnecting = true;
				await reconnectWithBackoff();
				isReconnecting = false;
			}
		} else if (connection === 'open') {
			isConnected = true;
			store.writeToFile('./session.json');
			setConsoleLog('CONNECTED');
		}
	});

	sock.ev.on('messages.upsert', async (messageUpdate) => {
		if (messageUpdate.type === 'notify' && messageUpdate.messages) {
			setConsoleLog('NEW MESSAGES');
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

	const checkConnection = async ()=> {
		if (isConnected === false && isReconnecting === false) {
			isReconnecting = true;
			await reconnectWithBackoff();
			isReconnecting = false;

			checkConnection();
			
		} else if (isConnected === false && isReconnecting) {
			setConsoleLog(`AWAITING SYSTEM RECONNECTION IN ${connectionDelay}`);
			await new Promise(resolve => setTimeout(resolve, connectionDelay));

			checkConnection();

		} else {
			return true;
		}
	};

	const sendMessageToGroup = async (groupJid, message, retries = 3) => {
		while (retries > 0) {
			try {
				await checkConnection();

				await sock.sendMessage(groupJid, { text: message });
				setConsoleLog('MESSAGE SENT');
				console.log('Message sent to group:', groupJid);
				return;

			} catch (error) {
				retries -= 1;
				setConsoleLog('ERROR SENDING MESSAGE, RETRYING ...');
				console.error('Error sending message:', error);

				if (error.output?.statusCode === 428 && retries > 0) {
					await createSocket();
				}

				await new Promise(resolve => setTimeout(resolve, 5000));
			}
		}
	
		setConsoleLog('FAILED TO SEND MESSAGE AFTER RETRIES');
	};

	const hourStart = process.env.WA_MESSAGE_HOUR_START;
	const minuteStart = process.env.WA_MESSAGE_MINUTE_START;

	// schedule.scheduleJob(
	// 	{ hour: hourStart, minute: minuteStart, tz: 'Asia/Jakarta' }, () => {
	// 		try {
	// 			setConsoleLog('SENDING GREET MESSAGE');
	// 			const greet = [
	// 				'Selamat Sore Bapak dan Ibu yang ada di Kalurahan Srikayangan 😃👋🌃\n',
	// 				'Izinkan saya sebagai bot WAWE menginformasikan prakiraan cuaca dari *BMKG* untuk besok 💫'
	// 			];
				
	// 			sendMessageToGroup(process.env.WA_GROUP_ID, greet.join('\n'));
	
	// 		} catch (error) {
	// 			setConsoleLog('ERROR IN GREETING MESSAGE');
	// 			console.error(error);
	
	// 		}
	// 	}
	// );

	schedule.scheduleJob(
		{ hour: hourStart, minute: minuteStart, tz: 'Asia/Jakarta' }, async () => {
			try {
				setConsoleLog('SENDING WEATHER MESSAGE');
				const message = await getWeatherPrediction(process.env.WA_COUNTY_CODE);
				if (message !== null) {
					sendMessageToGroup(process.env.WA_GROUP_ID, message.join('\n\n'));
				}
	
			} catch (error) {
				setConsoleLog('ERROR IN PREDICTION MESSAGE');
				console.error(error);
	
			}
		}
	);
}

console.log('Current time in Asia/Jakarta:', moment().tz('Asia/Jakarta').format());
createSocket();

// '☀🌤⛅🌥☁🌦🌧⛈🌩☄ 📑💫😃👋🌃'
// https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=34.01.06.2002
