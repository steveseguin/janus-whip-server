'use strict';

// Exercise the actual REST handlers and Janus transport without opening sockets.
// Run with Node 18+: node --test tests/trickle.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const noop = () => {};
const debug = () => noop;
const offer = 'v=0\r\na=ice-ufrag:client1\r\na=ice-pwd:password1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n';
const answer = 'v=0\r\na=ice-ufrag:server1\r\na=ice-pwd:serverpassword1\r\n';
const firstCandidate = 'candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host';
const secondCandidate = 'candidate:2 1 UDP 1686052607 198.51.100.1 6000 typ srflx raddr 192.0.2.1 rport 5000';

function load(relativePath, dependencies, suffix = '') {
	const filename = path.join(root, relativePath);
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(filename, 'utf8') + suffix, {
		module,
		exports: module.exports,
		require(name) {
			assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
			return dependencies[name];
		},
		console,
		setTimeout() { throw new Error('Unexpected timer'); },
		setInterval() { throw new Error('Unexpected timer'); },
		clearInterval: noop
	}, { filename });
	return module.exports;
}

function fixture({ deferRestart = false, failRestart = false } = {}) {
	const WhipJanus = load('src/whip-janus.js', { websocket: { client: function() {} }, debug });
	const janus = new WhipJanus({ address: 'ws://unused.invalid' });
	const messages = [];
	let handle = 0;
	let pendingRestart;
	janus.config.janus.session.id = 123;
	janus.config.janus.state = 'connected';
	janus.config.ws = { connection: { sendUTF(payload) {
		const message = JSON.parse(payload);
		messages.push(message);
		const callback = janus.config.janus.transactions[message.transaction];
		if (!callback) return;
		if (message.janus === 'attach') {
			callback({ janus: 'success', transaction: message.transaction, data: { id: ++handle } });
		} else if (message.janus === 'message') {
			callback({ janus: 'ack', transaction: message.transaction });
			const complete = () => {
				if (message.body.request === 'configure' && failRestart) {
					callback({ janus: 'error', transaction: message.transaction, error: { reason: 'Restart rejected' } });
				} else {
					callback({ janus: 'event', transaction: message.transaction,
						plugindata: { data: { id: 789 } }, jsep: { type: 'answer', sdp: answer } });
				}
			};
			if (message.body.request === 'configure' && deferRestart) pendingRestart = complete;
			else complete();
		} else {
			callback({ janus: 'ack', transaction: message.transaction });
		}
	} } };

	const routes = new Map();
	const router = {};
	for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete', 'options']) {
		router[method] = (route, handler) => routes.set(`${method} ${route}`, handler);
	}
	const config = { janus: {}, rest: '/whip', strictETags: false };
	const server = load('src/server.js', {
		async: { series: noop }, express: { Router: () => router }, cors: () => noop,
		'colors/safe': {}, debug, './whip-janus.js': WhipJanus, './config.js': config,
		'body-parser': { json: () => noop, text: () => noop }
	}, '\nmodule.exports = { setupRest, setJanus(value) { janus = value; } };');
	server.setJanus(janus);
	server.setupRest({ use: noop });

	function request(method, route, { params = {}, headers = {}, body = '' } = {}) {
		const response = {
			statusCode: 200, headers: {}, body: '',
			status(code) { this.statusCode = code; return this; },
			setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
			set(name, value) { return this.setHeader(name, value); },
			writeHeader(code, values) {
				this.status(code);
				for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
				return this;
			},
			send(body) { this.body = body; this.ended = true; return this; },
			sendStatus(code) { return this.status(code).send(''); },
			write(body) { this.body += body; return this; },
			end() { this.ended = true; return this; }
		};
		routes.get(`${method} ${route}`)({ params, headers, body }, response);
		if (!pendingRestart) assert.equal(response.ended, true, 'request must complete');
		return response;
	}

	const created = request('post', '/create', { body: { id: 'stream', room: 1234, token: 'test-token' } });
	assert.equal(created.statusCode, 200);
	const published = request('post', '/endpoint/:id', {
		params: { id: 'stream' }, headers: { 'content-type': 'application/sdp', authorization: 'Bearer test-token' }, body: offer
	});
	assert.equal(published.statusCode, 201);
	const rid = published.headers.location.split('/').pop();
	return {
		janus, messages,
		completeRestart() {
			assert.equal(typeof pendingRestart, 'function');
			const complete = pendingRestart;
			pendingRestart = undefined;
			complete();
		},
		patch(body, headers = {}) {
			return request('patch', '/resource/:rid', {
				params: { rid }, body,
				headers: { 'content-type': 'application/trickle-ice-sdpfrag', authorization: 'Bearer test-token', ...headers }
			});
		},
		trickles() { return messages.filter(message => message.janus === 'trickle'); }
	};
}

function fragment(lines, restart = false) {
	return `a=ice-ufrag:client${restart ? 2 : 1}\r\na=ice-pwd:password${restart ? 2 : 1}\r\n` +
		'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n' + lines.join('\r\n') + '\r\n';
}

function expectedCandidates() {
	return [
		{ sdpMLineIndex: 0, candidate: firstCandidate },
		{ sdpMLineIndex: 0, candidate: secondCandidate },
		{ completed: true }
	];
}

for (const restart of [false, true]) {
	test(`${restart ? 'ICE restart' : 'ordinary PATCH'} delivers all candidates and completion in order`, () => {
		const f = fixture();
		const response = f.patch(fragment([`a=${firstCandidate}`, `a=${secondCandidate}`, 'a=end-of-candidates'], restart));
		assert.equal(response.statusCode, restart ? 200 : 204);
		const trickles = f.trickles();
		assert.deepEqual(trickles.map(message => message.candidate), expectedCandidates());
		assert.ok(trickles.every(message => message.session_id === 123 && message.handle_id === 1));
		assert.equal(Object.keys(f.janus.config.janus.transactions).length, 0);
		if (restart) {
			const configureIndex = f.messages.findIndex(message => message.body?.request === 'configure');
			const trickleIndex = f.messages.findIndex(message => message.janus === 'trickle');
			assert.ok(trickleIndex > configureIndex, 'restart must finish before trickling');
		}
	});
}

test('a completion-only PATCH reaches Janus', () => {
	const f = fixture();
	assert.equal(f.patch(fragment(['a=end-of-candidates'])).statusCode, 204);
	assert.deepEqual(f.trickles().map(message => message.candidate), [{ completed: true }]);
});

test('separate PATCH requests each deliver their candidate exactly once', () => {
	const f = fixture();
	for (const candidate of [firstCandidate, secondCandidate]) {
		assert.equal(f.patch(fragment([`a=${candidate}`])).statusCode, 204);
	}
	assert.deepEqual(f.trickles().map(message => message.candidate), expectedCandidates().slice(0, 2));
});

test('an empty fragment sends no candidates', () => {
	const f = fixture();
	assert.equal(f.patch(fragment([])).statusCode, 204);
	assert.deepEqual(f.trickles(), []);
});

test('an unauthorized PATCH sends no candidates', () => {
	const f = fixture();
	assert.equal(f.patch(fragment([`a=${firstCandidate}`]), { authorization: 'Bearer wrong-token' }).statusCode, 403);
	assert.deepEqual(f.trickles(), []);
});

test('direct singular transport calls retain their existing behavior', () => {
	const f = fixture();
	f.janus.trickle({ uuid: 'WHIP Publisher 1234', candidate: { completed: true } });
	assert.deepEqual(f.trickles().map(message => message.candidate), [{ completed: true }]);
});

test('the transport still queues candidates until a handle exists', () => {
	const f = fixture();
	f.janus.addSession({ uuid: 'pending' });
	f.janus.trickle({ uuid: 'pending', candidate: { completed: true } });
	assert.deepEqual(f.trickles(), []);
	let completed = false;
	f.janus.publish({ uuid: 'pending', room: 1234, jsep: { type: 'offer', sdp: offer } }, err => {
		assert.equal(err, null);
		completed = true;
	});
	assert.equal(completed, true);
	assert.deepEqual(f.trickles().map(message => message.candidates), [[{ completed: true }]]);
});


test('restart candidates wait for the delayed Janus answer', () => {
	const f = fixture({ deferRestart: true });
	const response = f.patch(fragment([`a=${firstCandidate}`, 'a=end-of-candidates'], true));
	assert.equal(response.ended, undefined);
	assert.deepEqual(f.trickles(), []);
	f.completeRestart();
	assert.equal(response.ended, true);
	assert.equal(response.statusCode, 200);
	assert.deepEqual(f.trickles().map(message => message.candidate), [expectedCandidates()[0], { completed: true }]);
});

test('a rejected restart does not trickle its candidates', () => {
	const f = fixture({ deferRestart: true, failRestart: true });
	const response = f.patch(fragment([`a=${firstCandidate}`], true));
	assert.deepEqual(f.trickles(), []);
	f.completeRestart();
	assert.equal(response.ended, true);
	assert.equal(response.statusCode, 400);
	assert.deepEqual(f.trickles(), []);
});
