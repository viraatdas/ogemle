import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-in-production';

interface Client {
  id: string;
  socket: WebSocket;
  partnerId?: string;
  wantsChat: boolean;
  isAlive: boolean;
  connectedAt: number;
  pairedAt?: number;
}

interface ConversationRecord {
  duration: number;
  endedAt: number;
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

const stats = {
  totalVisitors: 0,
  activeConversations: 0,
  conversationHistory: [] as ConversationRecord[],
};

const wss = new WebSocketServer({ noServer: true });
const clients = new Map<string, Client>();
const waitingQueue: string[] = [];

const httpServer = http.createServer((req, res) => {
  if (req.url === '/admin' && req.method === 'GET') {
    const adminPath = path.join(__dirname, 'admin.html');
    fs.readFile(adminPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Admin page not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (req.url === '/stats' && req.method === 'GET') {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (token !== ADMIN_PASSWORD) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const buckets = {
      '0-30s': 0,
      '30s-1m': 0,
      '1-5m': 0,
      '5-15m': 0,
      '15m+': 0,
    };

    stats.conversationHistory.forEach((record) => {
      const duration = record.duration;
      if (duration < 30) buckets['0-30s']++;
      else if (duration < 60) buckets['30s-1m']++;
      else if (duration < 300) buckets['1-5m']++;
      else if (duration < 900) buckets['5-15m']++;
      else buckets['15m+']++;
    });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    res.end(
      JSON.stringify({
        totalVisitors: stats.totalVisitors,
        activeConversations: stats.activeConversations,
        conversationHistory: {
          total: stats.conversationHistory.length,
          distribution: buckets,
        },
        currentlyConnected: clients.size,
        queueLength: waitingQueue.length,
      })
    );
    return;
  }

  if (req.url === '/stats' && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] signaling server listening on http://localhost:${PORT}`);
});

wss.on('connection', (socket) => {
  const clientId = nanoid();
  const client: Client = {
    id: clientId,
    socket,
    wantsChat: false,
    isAlive: true,
    connectedAt: Date.now(),
  };
  clients.set(clientId, client);
  stats.totalVisitors++;

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
      if (client.pairedAt && partner.pairedAt) {
        const duration = Math.floor((Date.now() - Math.max(client.pairedAt, partner.pairedAt)) / 1000);
        stats.conversationHistory.push({ duration, endedAt: Date.now() });
        stats.activeConversations = Math.max(0, stats.activeConversations - 1);
      }

      partner.partnerId = undefined;
      partner.pairedAt = undefined;
      send(partner, { type: 'partner_left' });
      send(partner, { type: 'status', payload: { message: 'Partner disconnected.' } });
    }
  }

  client.partnerId = undefined;
  client.pairedAt = undefined;
  client.wantsChat = false;
}

function connectPair(offerer: Client, answerer: Client) {
  const now = Date.now();
  offerer.partnerId = answerer.id;
  answerer.partnerId = offerer.id;
  offerer.wantsChat = false;
  answerer.wantsChat = false;
  offerer.pairedAt = now;
  answerer.pairedAt = now;

  stats.activeConversations++;

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
