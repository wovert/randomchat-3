require('@std/esm');

import http from 'http';
import app from './app';
import socketIO from 'socket.io';
import BOT from './bot';

const server = http.createServer(app);

const hostname = '127.0.0.1';
const port = 8080;

const io = socketIO(server);

/**
 * NOTE:
 * This is a minimal in memory DB used for MVP
 * It's not designed to be efficent. One improvement here could be to move from arrays to queues
 * We're also not persisting data. An improvement here could be to add Redis or an actual db
 */
const rooms = [[]];			// list of chatrooms: [[socket1, socket2]]
const roomMap = {};			// O(1) lookup of the room assigned to a given socket
const auth = {}; 				// maps socketIDs to bool
const msgQueues = {}; 	// maps socketIDs to array of queued messages for this socket

server.listen(port, hostname, () => {
	console.log(`Server running on port ${hostname}:${port}`);
});

io.on('connection', (s1) => {
	const room = rooms.find(rm => rm.length < 2);

	if (room) {
		// notify client
		const s2 = room[0];
		const newChat = { ...BOT.newChat, timestamp: new Date() };
		if (s2 && auth[s2.id]) {
			s2.emit('chat', newChat);
		} else if (s2) {
			// wait for s2 to login before notifying
			msgQueues[s2.id].push(newChat);
		}

		// add this socket to the available room
		room.push(s1);
		const roomID = rooms.indexOf(room);
		roomMap[s1.id] = roomID;
	} else {
		// add s1 to a new room and wait for next available socket
		rooms.push([s1]);
		roomMap[s1.id] = rooms.length - 1;
	}

	msgQueues[s1.id] = []; // init the msgQueue for this socket

	s1.emit('init', { bot: BOT.handle });
	s1.emit('chat', { ...BOT.intro, timestamp: new Date() });

	s1.on('chat', (msg) => {
		const roomID = roomMap[s1.id];
		const s2 = rooms[roomID].find(s => s.id !== s1.id);
		if (s2 && auth[s2.id]) {
			// if s1 has authed, transfer message
			s2.emit('chat', msg);
		} else if (s2) {
			// else queue message
			const msgQueue = s2 && msgQueues[s2.id];
			msgQueue.push(msg);
		}
	});

	s1.on('login', () => {
		// mark s1 as logged in
		auth[s1.id] = true;

		const roomID = roomMap[s1.id];
		const s2 = rooms[roomID].find(s => s.id !== s1.id);
		if (rooms[roomID].length > 1 && s2 && auth[s2.id]) {
			// start chat if room has 2 chatters && s2 has authed
			s1.emit('chat', { ...BOT.startChat, timestamp: new Date() });
		} else {
			// notify client that chat is pending
			s1.emit('chat', { ...BOT.enqueue, timestamp: new Date() });
		}

		// if s1 has any queued messages at login, send them now
		const queue = msgQueues[s1.id];
		if (queue && queue.length > 0) {
			queue.forEach(queuedMsg => s1.emit('chat', queuedMsg));
		}
	});

	s1.on('disconnect', () => {
		// remove s1 from its chat room
		const roomID = roomMap[s1.id];
		const i = rooms[roomID].indexOf(s1);
		rooms[roomID].splice(i, 1);

		// clean cached s1 data
		if (auth.hasOwnProperty(s1.id)) { delete auth[s1.id]; }
		if (msgQueues.hasOwnProperty(s1.id)) { delete msgQueues[s1.id]; }
		if (roomMap.hasOwnProperty(s1.id)) { delete roomMap[s1.id]; }

		// handle the other socket in s1's old room
		const s2 = rooms[roomID][0];
		if (s2) {
			s2.emit('chat', { ...BOT.endChat, timestamp: new Date() });
			const lastRoom = rooms[rooms.length - 1];
			if (lastRoom.length === 1 && lastRoom[0].id !== s2.id) {
				// the last room has another socket waiting. Let's match them
				lastRoom.push(s2);
				lastRoom[0].emit('chat', { ...BOT.dequeue, timestamp: new Date() });
				s2.emit('chat', { ...BOT.newChat, timestamp: new Date() });
			} else {
				// there isn't a room with a socket waiting. Let's enqueue s2
				rooms.splice(roomID, 1); // not super efficent but fine for MVP
				rooms.push([s2]);
				s2.emit('chat', { ...BOT.enqueue, timestamp: new Date() });
			}
			roomMap[s2.id] = rooms.length - 1;
		}
	});

	s1.on('hop', () => {
		const roomID = roomMap[s1.id];

		// do nothing as s1 is already the next in queue
		if (rooms[roomID].length === 1) return;

		// get the other socket possibly in s1's room
		const s2 = rooms[roomID].find(sckt => sckt.id !== s1.id);

		// delete the room. not super efficient but OK for MVP
		rooms.splice(roomID, 1);

		// match a socket with a pending socket or enqueue it
		const hop = (socket) => {
			const lastRoom = rooms[rooms.length - 1];
			if (lastRoom.length === 1) {
				// reconnect socket with a pending socket
				const temp = lastRoom[0];
				lastRoom.push(socket);
				lastRoom.forEach((sckt) => { roomMap[sckt.id] = rooms.length - 1; });
				// notify clients
				temp.emit('chat', { ...BOT.dequeue, timestamp: new Date() });
				socket.emit('chat', { ...BOT.newChat, timestamp: new Date() });
			} else if (lastRoom.length >= 2) {
				// enqueue socket
				rooms.push([socket]);
				roomMap[socket.id] = rooms.length - 1;
				socket.emit('chat', { ...BOT.enqueue, timestamp: new Date() });
			}
		};

		// handle s1
		hop(s1);

		// handle s2
		s2.emit('chat', { ...BOT.endChat, timestamp: new Date() });
		hop(s2);
	});

	s1.on('help', () => {
		s1.emit('chat', { ...BOT.help, timestamp: new Date() });
	});
});
