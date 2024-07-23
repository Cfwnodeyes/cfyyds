// <!--GAMFC-->version base on commit 841ed4e9ff121dde0ed6a56ae800c2e6c4f66056, time is 2024-04-16 18:02:37 UTC<!--GAMFC-END-->.
// @ts-ignore
// from https://github.com/zizifn/edgetunnel/blob/main/src/worker-vless.js
// by zeb
import { connect } from 'cloudflare:sockets';

// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"


let userID = 'ffd4a11a-9643-4f37-861c-9cb52f39a6ce';

let proxyIP = 'cdn.xn--b6gac.eu.org'; // ts.hpc.tw workers.cloudflare.cyou // bestproxy.onecf.eu.org // cdn-all.xn--b6gac.eu.org

let password = 'zeb';


if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const url_uuid = url.searchParams.get('uuid');
			const url_proxyip = url.searchParams.get('proxyip');

			userID = env.UUID || url_uuid || userID;
			proxyIP = env.PROXYIP || url_proxyip || proxyIP;

			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				switch (url.pathname) {
					case '/':
						return new Response('Not found', { status: 404 });
					case `/${password}`: {
						const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'), url_proxyip);
						return new Response(`${vlessConfig}`, {
							status: 200,
							headers: {
								"Content-Type": "text/html;charset=utf-8",
							}
						});
					}
					default:
						return new Response('Not found', { status: 404 });
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};




/**
 * 
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {

	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;

	// ws --> remote
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID);
			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
				} `;
			if (hasError) {
				// controller.error(message);
				throw new Error(message); // cf seems has bug, controller.error will not end stream
				// webSocket.close(1000, message);
				return;
			}
			// if UDP but port not DNS port, close it
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					// controller.error('UDP proxy only enable for DNS which is port 53');
					throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
					return;
				}
			}
			// ["version", "附加信息长度 N"]
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			// TODO: support udp here when cf runtime has udp support
			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {
	async function connectAndWrite(address, port) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	// if the cf connect tcp socket have no incoming data, we retry to redirect ip
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		// no matter retry success or not, close websocket
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 * @param {(info: string)=> void} log for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocketServer.addEventListener('close', () => {
				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			}
			);
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			}
			);
			// for ws 0rtt
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});

	return stream;

}

// https://xtls.github.io/development/protocols/vless.html
// https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw

/**
 * 
 * @param { ArrayBuffer} vlessBuffer 
 * @param {string} userID 
 * @returns 
 */
function processVlessHeader(
	vlessBuffer,
	userID
) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
		isValidUser = true;
	}
	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	//skip opt for now

	const command = new Uint8Array(
		vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];

	// 0x01 TCP
	// 0x02 UDP
	// 0x03 MUX
	if (command === 1) {
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	// port is big-Endian in raw data etc 80 == 0x005d
	const portRemote = new DataView(portBuffer).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(
		vlessBuffer.slice(addressIndex, addressIndex + 1)
	);

	// 1--> ipv4  addressLength =4
	// 2--> domain name addressLength=addressBuffer[1]
	// 3--> ipv6  addressLength =16
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			// seems no need add [] for ipv6
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}


/**
 * 
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log 
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	// remote--> ws
	let remoteChunkCount = 0;
	let chunks = [];
	/** @type {ArrayBuffer | null} */
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {
				},
				/**
				 * 
				 * @param {Uint8Array} chunk 
				 * @param {*} controller 
				 */
				async write(chunk, controller) {
					hasIncomingData = true;
					// remoteChunkCount++;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						// seems no need rate limit this, CF seems fix this??..
						// if (remoteChunkCount > 20000) {
						// 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
						// 	await delay(1);
						// }
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry();
	}
}

/**
 * 
 * @param {string} base64Str 
 * @returns 
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

/**
 * This is not real UUID validation
 * @param {string} uuid 
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}


/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(string)=> void} log 
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {

	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {

		},
		transform(chunk, controller) {
			// udp message 2 byte is the the length of udp data
			// TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {
		}
	});

	// only handle dns udp for now
	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch('https://1.1.1.1/dns-query',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: chunk,
				})
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			// console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				log(`doh success and dns message length is ${udpSize}`);
				if (isVlessHeaderSent) {
					webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
				} else {
					webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
					isVlessHeaderSent = true;
				}
			}
		}
	})).catch((error) => {
		log('dns udp has error' + error)
	});

	const writer = transformStream.writable.getWriter();

	return {
		/**
		 * 
		 * @param {Uint8Array} chunk 
		 */
		write(chunk) {
			writer.write(chunk);
		}
	};
}

/**
 * 
 * @param {string} userID 
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userID, hostName, proxyip) {
    if(userID == "ffd4a11a-9643-4f37-861c-9cb52f39a6ce"){
      return `不允许使用默认uuid 请新增uuid参数`;
    }
    let proxy_ip = "";
    if(proxyip !== null){
        proxy_ip = proxyip;
    }
	let clashmeta = `
  - type: vless
    name: 🇺🇸 ${hostName}
    server: www.visa.com
    port: 80
    uuid: ${userID}
    network: ws
    tls: false
    udp: false
    ws-opts:
    path: "/?ed=4096&proxyip=${proxy_ip}&uuid=${userID}"
    headers:
      host: ${hostName}
`;
	let clashmeta_tls=`
  - type: vless
    name: 🇺🇸 ${hostName}_tls
    server: www.visa.com
    port: 443
    uuid: ${userID}
    network: ws
    tls: true
    udp: false
    client-fingerprint: chrome
    ws-opts:
    path: "/?ed=4096&proxyip=${proxy_ip}&uuid=${userID}"
    headers:
      host: ${hostName}
`;

	return `
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">

<body class="w-100 h-100 d-flex flex-column p-5 overflow-hidden align-items-center justify-content-center">
  <div class="w-100 h-100 d-flex flex-column p-5 border rounded">
    <div class="d-flex align-items-start">
      <div class="nav flex-column nav-pills me-3" id="v-pills-tab" role="tablist" aria-orientation="vertical">
        <button class="nav-link active" id="v-pills-v2ray-tab" data-bs-toggle="pill" data-bs-target="#v-pills-v2ray"
          type="button" role="tab" aria-controls="v-pills-v2ray" aria-selected="true"
          style="font-size: 1.1rem;font-weight: 600;"><img
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAKpSURBVDhPlVRNTxNRFB1pE1KMIWXKAhaKC0kj6koT1uxFQBZqUmEBdKFFkWmtiS7AaIxNcIG0lHZjMK2AiSZGY6IxRhO1SYF2RCI7/0anba73vDdTO/2AeJKbvLnvnjPvfrynNENXPOtRY9v+zthPTY3lEjC53vZjzww7GN2Lu6oaza14Yjqpi5vU8eS7zeATe0u5BGJNWmO44ztHObigPt2iI/de0+HwOrWF0mwp09LChz3EeKK6AY5Jt8Mdz0KM2h98ECSX9pyUyQgpE4/txj7sIQax4IBrykh0P0Oa+UL7QynmvB6VZN88KaMhUi5q0rCGj/cQI0SZA66trmpUX0EKCAi+ytBGdo82Mr8o/XWLlOFbNlt480XsIeZl7o/ggKvG9IQQgzKOjbq4tFXS1j/R+0yOgIJh0KH+wYrY2jdd+IFSqURjt+eodXhWcKHRFf/tUVjZj87hT6JmnFLvpWlBKhQK1HLiLDlHNVr7sSN8gFEs0sRMmBy95zj9iDwla6hx3c+COQ3j0BZ6IevGdfIGHgkiBF0n++nd5q74BoosNhbQyHH8jKwpc8DtWOCRWs4HFXVJT0jBlBTk4lcLvv34WayBcrlMg75JcvSclmVAo4RgSgpG9eS+grUYGLlMLcf6SLlwYx9Bvk7NUraAkw2MXGGxU6ScD1Sa1DjlBk2pFixyN4euTtWLwXxzLFjTlNqxwR+9NyMVsfFpbkAPi1lpWmaeDhzb2AAYSmuwcQO8d5NU4jSnZu/8a0ADMec1eVvAdS9z/SzIq6cb1tXrm0/RePg+OXkGBRnFh2Hd8OrpRt2TVvs4tA7NiPqAbDc8DqtSrNnjYOF/ny+crOnzZUE+sPkk/ozOYRyqDT6xxzOHUpm0g4GOYaQ6o/kgfgATa/ZVulkHRfkLLibztIsSp/sAAAAASUVORK5CYII="
            style="background: #fff;margin: 5px;padding: 3px;border-radius: 3px;" />v2ray</button>
        <button class="nav-link" id="v-pills-clash_meta-tab" data-bs-toggle="pill" data-bs-target="#v-pills-clash_meta"
          type="button" role="tab" aria-controls="v-pills-clash_meta" aria-selected="false"
          style="font-size: 1.1rem;font-weight: 600;"><img
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAKaSURBVDhPrZNvSBNhHMd/zeqF+TZ6kUkZxryWMWe6VabL+WKr6Zs0yPWi7phkd6S+KDXyCjJEo3Ir3NkfylBoWv5baaaFZZbbiyJ6Fb2oQLIYxFzUm/DpeW7PzZ06SvALH+75/fl+7zjuYNlldvuPFLj8fyxu/2xhi99O2/+tAldgH/HijFlLyyQHFleAt7gDaI5XRYDQCrofX3jHciVgi/UWuCcFyGue4M2XXiPCXsLlSbTr/FgttcWV6dyzmvymlyi/eQKZL0YRIPfCGL+n8QWaT27j+CD1LlBu0/ijxTy7G54LYBRHeJP4FJnqCaNo59nIVe6JI29pRlTGM6Nv5PkiGOufCJBdM8Rn1z5G2TUUfM6pG0Y5tcORum74S9bJQRcBzz7LfZnIPqnJPql3nBoSQF81wGdW+ZCC/sRgeWa1bzq2txj6yoGvmZUPOVWv2ifAdr6Pz6joRQogihqD2J+47VjPVGxfTc+UwdmfKIpIo+of7xGAYe/xW7luxLBdMiSQvCuEPwudszuYznl/MJw3yLDeYDpLzl3TIt0hgYpP5qhXAK2jg9/i6EAKSiCRwSmtghJvAi2hBJ/lHhUJjHoPd6K0srsCbDpwm08tbUeEzQfbVYH/FA4knlTKxtI7AqTYr/MpxbeQTNHNJQduwB7iSynG2G8IkGxrY5NtEiKst0pLDlS8Mvs9HJ0AMBVXk/CdGFqqpHU+MOnK7xfSUiXiyXC0r6ElwIwHOjAf56H6Q3Rs37osoUtPS1mhVni3wCdBJx3P6b0Iqz80JK2lZVyRHbJLS7VEETQ4/XRYgk/4zr/DrZBPR3E1c21lHn6qX8RDvCRDHoQ9cCjkge8/JbDigVZuLkH4AdJCUoIVZ3wLt2nKaHu5BPAXKbnWQHWKE4EAAAAASUVORK5CYII="
            style="background: #fff;margin: 5px;padding: 3px;border-radius: 3px;" />clash meta</button>
      </div>
      <div class="tab-content flex-fill " id="v-pills-tabContent">
        <div class="tab-pane fade show active" id="v-pills-v2ray" role="tabpanel" aria-labelledby="v-pills-v2ray-tab"
          tabindex="0">
          <div class="m-4 w-100 d-flex flex-column p-5 border rounded mb-5">
            <div class="mb-5">
              <label for="v2_tls" class="form-label">v2ray tls（客户端需要开启分片功能）</label>
              <textarea class="form-control mb-3" id="v2_tls" rows="">vless://${userID}\u0040www.visa.com:443?encryption=none&security=tls&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D4096%26proxyip%3D${proxy_ip}%26uuid%3D${userID}#🇺🇸%20${hostName}_tls</textarea>
              <button type="button" class="btn btn-primary" onclick="
              const input = document.createElement('textarea');
              input.value = 'vless://${userID}\u0040www.visa.com:443?encryption=none&security=tls&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D4096%26proxyip%3D${proxy_ip}%26uuid%3D${userID}#🇺🇸%20${hostName}_tls';
              document.body.appendChild(input);
              input.select();
              document.execCommand('copy');
              document.body.removeChild(input);
              alert('已经复制到剪贴板');
              ">复制</button>
            </div>
            <div>
              <label for="v2" class="form-label">v2ray</label>
              <textarea class="form-control mb-3" id="v2" rows="">vless://${userID}\u0040www.visa.com:80?encryption=none&security=none&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D4096%26proxyip%3D${proxy_ip}%26uuid%3D${userID}#🇺🇸%20${hostName}</textarea>
              <button type="button" class="btn btn-primary" onclick="
              const input = document.createElement('textarea');
              input.value = 'vless://${userID}\u0040www.visa.com:80?encryption=none&security=none&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D4096%26proxyip%3D${proxy_ip}%26uuid%3D${userID}#🇺🇸%20${hostName}';
              document.body.appendChild(input);
              input.select();
              document.execCommand('copy');
              document.body.removeChild(input);
              alert('已经复制到剪贴板');
              ">复制</button>
            </div>

          </div>
        </div>
        <div class="tab-pane fade" id="v-pills-clash_meta" role="tabpanel" aria-labelledby="v-pills-clash_meta-tab"
          tabindex="0">
          <div class="m-4 w-100 d-flex flex-column p-5 border rounded">
            <div class="mb-5">
              <label for="cl_tls" class="form-label">clash meta tls</label>
              <textarea class="form-control mb-3" id="cl_tls" style="height:150px">${clashmeta_tls}</textarea>
              <button type="button" class="btn btn-primary" onclick="
              const input = document.createElement('textarea');
              input.value = document.getElementById('cl_tls').value;
              document.body.appendChild(input);
              input.select();
              document.execCommand('copy');
              document.body.removeChild(input);
              alert('已经复制到剪贴板');
              ">复制</button>
            </div>
            <div>
              <label for="cl" class="form-label">clash meta</label>
              <textarea class="form-control mb-3" id="cl" style="height:150px">${clashmeta}</textarea>
              <button type="button" class="btn btn-primary" onclick="
              const input = document.createElement('textarea');
              input.value = document.getElementById('cl').value;
              document.body.appendChild(input);
              input.select();
              document.execCommand('copy');
              document.body.removeChild(input);
              alert('已经复制到剪贴板');
              ">复制</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
`;
}
