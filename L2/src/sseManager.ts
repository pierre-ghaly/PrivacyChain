import type { Response } from 'express';

interface Client {
  res: Response;
}

class SseManager {
  private clients = new Map<string, Client[]>();

  add(user: string, res: Response): void {
    const key = user.toLowerCase();
    const list = this.clients.get(key) ?? [];
    list.push({ res });
    this.clients.set(key, list);
  }

  remove(user: string, res: Response): void {
    const key = user.toLowerCase();
    const filtered = (this.clients.get(key) ?? []).filter(c => c.res !== res);
    if (filtered.length === 0) this.clients.delete(key);
    else this.clients.set(key, filtered);
  }

  push(user: string, event: string, data: object): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.get(user.toLowerCase()) ?? []) {
      try { client.res.write(payload); } catch { /* client disconnected */ }
    }
  }
}

export const sseManager = new SseManager();
