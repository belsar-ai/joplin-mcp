import { JoplinApiClient } from '../api/client.js';
import { Broker } from '../sandbox/broker.js';

export class ScriptExecutor {
  private broker: Broker;

  constructor(client: JoplinApiClient) {
    this.broker = new Broker(client);
  }

  async execute(code: string): Promise<unknown> {
    return this.broker.execute(code);
  }

  async shutdown(): Promise<void> {
    await this.broker.shutdown();
  }
}
