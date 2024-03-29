import { BaseModel } from './base';
import { ITransaction } from './transaction';
import { IBlock } from '../types/Block';
import { ICoin } from './coin';

export namespace IEvent {
  export type BlockEvent = Partial<IBlock>;
  export type TxEvent = Partial<ITransaction>;
  export type CoinEvent = { coin: Partial<ICoin>; address: string };
}
interface IEvent {
  payload: IEvent.BlockEvent | IEvent.TxEvent | IEvent.CoinEvent;
  type: 'block' | 'tx' | 'coin';
  emitTime: Date;
}
class Event extends BaseModel<IEvent> {
  constructor() {
    super('events');
  }

  allowedPaging = [];

  async onConnect() {
    this.collection.createIndex({ type: 1, emitTime: 1 }, { background: true });
    //https://docs.mongodb.com/manual/core/capped-collections/
    //Capped collections are fixed-size collections that support high-throughput operations that insert and retrieve documents based on insertion order. Capped collections work in a way similar to circular buffers
    const capped = await this.collection.isCapped();
    if (!capped) {
      //the size option is mandatory, in bytes
      this.db!.createCollection('events', { capped: true, size: 10000 });
    }
  }

  public signalBlock(block: IEvent.BlockEvent) {
    this.collection.insertOne({ payload: block, emitTime: new Date(), type: 'block' });
  }

  public signalTx(tx: IEvent.TxEvent) {
    this.collection.insertOne({ payload: tx, emitTime: new Date(), type: 'tx' });
  }

  public signalAddressCoin(payload: IEvent.CoinEvent) {
    this.collection.insertOne({ payload, emitTime: new Date(), type: 'coin' });
  }

  public getBlockTail(lastSeen: Date) {
    return this.collection.find({ type: 'block', emitTime: { $gte: lastSeen } }).addCursorFlag('noCursorTimeout', true);
  }

  public getTxTail(lastSeen: Date) {
    return this.collection.find({ type: 'tx', emitTime: { $gte: lastSeen } }).addCursorFlag('noCursorTimeout', true);
  }

  getCoinTail(lastSeen: Date) {
    return this.collection.find({ type: 'coin', emitTime: { $gte: lastSeen } }).addCursorFlag('noCursorTimeout', true);
  }
}
export const EventModel = new Event();
