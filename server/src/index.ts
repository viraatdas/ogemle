import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';

const PORT = Number(process.env.PORT) || 8080;

interface Client {
  id: string;
  socket: WebSocket;
  partnerId?: string;
  wantsChat: boolean;
  isAlive: boolean;
}

type SignalMessage = {
  kind: 'offer' | 'answer' | 'ice';
  data: unknown;
};

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'signal'; payload: SignalMessage }
  | { type: 'leave' };

type MatchPayload = { partnerId: string; role: 'offerer' | 'answerer' };

type OutgoingMessage =
  | { type: 'status'; payload: { message: string } }
  | { type: 'match'; payload: MatchPayload }
  | { type: 'signal'; payload: SignalMessage }
  | { type: 'partner_left' }
  | { type: 'error'; payload: { message: string } };

const wss = new WebSocketServer({ port: PORT });
const clients = new Map<string, Client>();
const waitingQueue: string[] = [];

wss.on('connection', (socket) => {
  const clientId = nanoid();
  const client: Client = { id: clientId, socket, wantsChat: false, isAlive: true };
  clients.set(clientId, client);

  send(client, {
    type: 'status',
    payload: { message: 'Connected to signaling server. Click "Start" to find someone.' },
  });

  socket.on('pong', () => {
    client.isAlive = true;
  });

  socket.on('message', (raw) => {
    handleMessage(client, raw.toString());
  });

  socket.on('close', () => {
    cleanupClient(clientId);
  });

  socket.on('error', (err) => {
    console.error(`[server] socket error for ${clientId}`, err);
    cleanupClient(clientId);
  });
});

const heartbeat = setInterval(() => {
  for (const [id, client] of clients) {
    if (!client.isAlive) {
      console.warn(`[server] terminating dead connection ${id}`);
      client.socket.terminate();
      cleanupClient(id);
      continue;
    }

    client.isAlive = false;
    try {
      client.socket.ping();
    } catch (error) {
      console.error(`[server] failed to ping ${id}`, error);
      cleanupClient(id);
    }
  }
}, 30_000);

wss.on('close', () => {
  clearInterval(heartbeat);
});

function handleMessage(client: Client, raw: string) {
  let message: IncomingMessage | undefined;

  try {
    message = JSON.parse(raw) as IncomingMessage;
  } catch (error) {
    send(client, { type: 'error', payload: { message: 'Invalid JSON payload' } });
    return;
  }

  if (!message) return;

  switch (message.type) {
    case 'ready':
      handleReady(client);
      break;
    case 'signal':
      handleSignal(client, message.payload);
      break;
    case 'leave':
      handleLeave(client);
      break;
    default:
      send(client, { type: 'error', payload: { message: 'Unknown message type' } });
  }
}

function handleReady(client: Client) {
  if (client.partnerId) {
    send(client, { type: 'status', payload: { message: 'Already chatting. Leave to find someone new.' } });
    return;
  }

  if (waitingQueue.includes(client.id)) {
    send(client, { type: 'status', payload: { message: 'Waiting for the next available partner...' } });
    return;
  }

  client.wantsChat = true;

  while (waitingQueue.length > 0) {
    const partnerId = waitingQueue.shift();
    if (!partnerId) break;
    const partner = clients.get(partnerId);
    if (!partner || partner.socket.readyState !== WebSocket.OPEN) {
      continue;
    }
    connectPair(client, partner);
    return;
  }

  waitingQueue.push(client.id);
  send(client, { type: 'status', payload: { message: 'Waiting for someone to join...' } });
}

function handleSignal(client: Client, payload: SignalMessage) {
  if (!client.partnerId) {
    send(client, { type: 'status', payload: { message: 'Waiting for a partner before sending media.' } });
    return;
  }

  const partner = clients.get(client.partnerId);
  if (!partner) {
    handleLeave(client);
    return;
  }

  send(partner, { type: 'signal', payload });
}

function handleLeave(client: Client) {
  removeFromQueue(client.id);

  if (client.partnerId) {
    const partner = clients.get(client.partnerId);
    if (partner) {
      partner.partnerId = undefined;
      send(partner, { type: 'partner_left' });
      send(partner, { type: 'status', payload: { message: 'Partner disconnected.' } });
    }
  }

  client.partnerId = undefined;
  client.wantsChat = false;
}

function connectPair(offerer: Client, answerer: Client) {
  offerer.partnerId = answerer.id;
  answerer.partnerId = offerer.id;
  offerer.wantsChat = false;
  answerer.wantsChat = false;

  send(offerer, { type: 'match', payload: { partnerId: answerer.id, role: 'offerer' } });
  send(answerer, { type: 'match', payload: { partnerId: offerer.id, role: 'answerer' } });
  send(offerer, { type: 'status', payload: { message: 'Connected! Start your video.' } });
  send(answerer, { type: 'status', payload: { message: 'Connected! Start your video.' } });
}

function cleanupClient(clientId: string) {
  const client = clients.get(clientId);
  if (!client) return;

  handleLeave(client);
  clients.delete(clientId);
}

function removeFromQueue(clientId: string) {
  const index = waitingQueue.indexOf(clientId);
  if (index >= 0) {
    waitingQueue.splice(index, 1);
  }
}

function send(client: Client, message: OutgoingMessage) {
  if (client.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  client.socket.send(JSON.stringify(message));
}

console.log(`[server] signaling server listening on ws://localhost:${PORT}`);
