const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { writeFileSync } = require('fs');
const { join } = require('path');
const { makeInMemoryStore } = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

var sock;
var isConnected = false;
var reconnectCount = 0;

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
		case 2:
			return '🌤';
		case 3:
			return '☁';
		case 17:
			return '⛈';
		case 61:
			return '🌦';
		default:
			return '🌧';
	}
}

function getWindStatus(wind) {
	if (wind <= 6) {
		return 'Angin Tidak Terasa';
	} else if (wind > 5 && wind <= 16) {
		return 'Angin lembut';
	} else if (wind > 16 && wind <= 27) {
		return 'Angin Kencang';
	} else if (wind > 27) {
		return 'Angin Badai';
	} else {
		return 'Tidak Terukur';
	}
}

function getTemperature(temp) {
	if (temp <= 27) {
		return 'Dingin';
	} else if (temp > 27 && temp <= 30) {
		return 'Biasa';
	} else if  (temp > 30 && temp <= 32) {
		return 'Hangat';
	} else if  (temp > 32) {
		return 'Panas';
	} else {
		return 'Tidak Terukur';
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

function getGreetMessage() {
	const greet = [
		'Selamat Sore Bapak dan Ibu yang ada di Kalurahan Srikayangan 😃👋🌃\n',
		'Izinkan saya sebagai bot WAWE menginformasikan prakiraan cuaca dari *BMKG* untuk besok 💫'
	];

	return greet.join('\n');
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
			`Suhu : ${getTemperature(parseInt(weather.t))}`,
            `Kelembapan : ${weather.hu} %`,
            `Asal Angin : ${getCompass(weather.wd)}`,
            `Arah Angin : ${getCompass(weather.wd_to)}`,
			`Kecepatan : ${getWindStatus(parseFloat(weather.ws))} (${weather.ws} km/jam)`
        ];
		
        messages.push(message.join('\n'));
    }

    return messages.join('\n\n');
}

async function createSocket() {
	const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

	if (sock) {
		sock.ev.removeAllListeners();
		sock.end();
	}

	sock = makeWASocket({ auth: state, });

	const reconnect = async () => {
		if (reconnectCount >= 5) {
			setConsoleLog('UNABLE TO RECONNECT! EXITING');
			await new Promise(resolve => setTimeout(resolve, 5000));
			process.exit(1);
		}

		setConsoleLog('CONNECTION CLOSED! RECONNECTING IN 5S');
		reconnectCount += 1;
		
		await new Promise(resolve => setTimeout(resolve, 5000));
		createSocket();
	};

	sock.ev.on('creds.update', saveCreds);
	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr) {
			setConsoleLog('SCAN TO AUTHENTICATE');
			qrcode.generate(qr, { small: true });
		}

		if (connection === 'close') {
			isConnected = false;

			if (lastDisconnect?.error?.output?.statusCode !== 401) {
				await reconnect();
			} else {
				setConsoleLog('LOGGED OUT: PLEASE DELETE AUTH FILES AND RESTART');
				process.exit(1);
			}

		} else if (connection === 'open') {
			isConnected = true;
			reconnectCount = 0;

			setConsoleLog('CONNECTED');
		}
	});

	sock.ev.on('messages.upsert', async (messageUpdate) => {
		if (messageUpdate.type === 'notify' && messageUpdate.messages) {
			setConsoleLog('NEW MESSAGES');
			messageUpdate.messages.forEach((message) => {
				const jid = message.key.remoteJid;
				jid.endsWith('@g.us') 
					? console.log('Group JID:', jid) 
					: console.log('Individual JID:', jid);
			});
		}
	});

	const sendMessageToGroup = async (groupJid, message) => {
		await sock.sendMessage(groupJid, { text: message });
		setConsoleLog(`MESSAGE SENT TO ${groupJid}`);
	};

	const countryCode = process.env.WA_COUNTY_CODE;
	const minuteStart = process.env.WA_MESSAGE_MINUTE_START;
	const hourStart = process.env.WA_MESSAGE_HOUR_START;
	
	schedule.scheduleJob(
		{ hour: hourStart, minute: minuteStart, tz: 'Asia/Jakarta' }, async () => {
			try {
				const message = await getWeatherPrediction(countryCode);
				const greet = getGreetMessage();

				while (!isConnected || reconnectCount !== 0) {
					await new Promise(resolve => setTimeout(resolve, 5000));
				}

				await sendMessageToGroup(process.env.WA_GROUP_ID, greet);
				await sendMessageToGroup(process.env.WA_GROUP_ID, message);
				
			} catch (error) {
				setConsoleLog('ERROR IN SENDING MESSAGE');
				console.error(error);
			}
		}
	);
}

createSocket();

// '☀🌤⛅🌥☁🌦🌧⛈🌩☄ 📑💫😃👋🌃'
// https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=34.01.06.2002
