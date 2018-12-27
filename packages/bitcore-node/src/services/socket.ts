import SocketIO = require('socket.io');
import { LoggifyClass } from '../decorators/Loggify';
import { EventModel, IEvent } from '../models/events';

import logger from '../logger';

@LoggifyClass
export class SocketService {
  io?: SocketIO.Server;
  id: number = Math.random();

  constructor() {
    this.setServer = this.setServer.bind(this);
    this.signalTx = this.signalTx.bind(this);
    this.signalBlock = this.signalBlock.bind(this);
    this.signalAddressCoin = this.signalAddressCoin.bind(this);
  }

  //SocketService is referenced by api.ts, block.ts and transaction.ts
  //socket.io - https://socket.io/docs/emit-cheatsheet/

  //api.ts call setServer to establish the connection between bitcore modules (api.ts) and socket.io
  setServer(io: SocketIO.Server) {
    this.io = io;
    //https://socket.io/docs/rooms-and-namespaces/#Rooms
    //as part of socket.io implementation, when there is a new client connected to our socket.io server,
    //a 'connection' event is fired, and the data passed in as part of this event is this 'socket' obj
    this.io.sockets.on('connection', socket => {
      logger.info(`YCM TRACKER === services/socket.ts setServer() on connection *************`);
      //TODO low: who will fire this 'room' event? what is this room about? socket.io notify this 'socket' there is a room for it to join?
      socket.on('room', room => {
        logger.info(`YCM TRACKER === services/socket.ts setServer() on room *************`);
        //get the socket join/subscribe to a given channel/room
        socket.join(room);
      });
    });
    this.wireupCursors();
  }

  //once the server is up, we wireupCursors(); once we wireup, each of the 3 cursors are recursively calling themselves after another 5s
  //so these are 3 concurrent recurring threads, repeatedly checking for new events registered in db, right from the start
  async wireupCursors() {
    let lastBlockUpdate = new Date();
    let lastTxUpdate = new Date();
    let lastAddressTxUpdate = new Date();

    //in the next 3 sections, it follows the same pattern: define a async func, and run it
    //    const retryXXXCursor = async () => {...}
    //    retryXXXCursor()
    //because they are all async, any one can take place before others

    //a sample snapshot of what is printed on the log
    //info: YCM TRACKER === services/socket.ts wireupCursors() 10
    //info: YCM TRACKER === services/socket.ts wireupCursors() 30
    //info: YCM TRACKER === services/socket.ts wireupCursors() 20
    //info: YCM TRACKER === services/socket.ts wireupCursors() 11 - got next tx event
    //info: YCM TRACKER === services/socket.ts wireupCursors() 12
    //info: YCM TRACKER === services/socket.ts wireupCursors() 13
    //info: YCM TRACKER === services/socket.ts wireupCursors() 14
    //info: YCM TRACKER === services/socket.ts wireupCursors() 31 - get next addr tx event
    //info: YCM TRACKER === services/socket.ts wireupCursors() 32
    //info: YCM TRACKER === services/socket.ts wireupCursors() 33
    //info: YCM TRACKER === services/socket.ts wireupCursors() 31 - get next addr tx event
    //info: YCM TRACKER === services/socket.ts wireupCursors() 32
    //info: YCM TRACKER === services/socket.ts wireupCursors() 33
    //info: YCM TRACKER === services/socket.ts wireupCursors() 34
    //info: YCM TRACKER === services/socket.ts wireupCursors() 35
    //info: YCM TRACKER === services/socket.ts wireupCursors() 23
    //info: YCM TRACKER === services/socket.ts wireupCursors() 24

    //interpretation
    //if there is only unconfirmed tx coming in, not a new block event, 
    //retryBlockCursor in retryBlockCursor will be skipped, we will see 20 23 24, not 20 21 22 23 24
    //for any unconfirmed tx, there will be address-tx associated with it, so retryTxCursor and retryAddressTxCursor will get involved at the same time
    //as we can see above, 10 11 12 13 14 and 30 31 32 33 31 32 33 34 35 (very often 31 32 33 is repeated for 2 times because we always have at least 2 addr for each tx)

    //essentially this wireupCursors func is to check if there is any new tx/block/addr-tx event after this func is called
    //if there is no new event to work on, sleep for 5 seconds and check again
    //if there is an event, socket.io will broadcast in the respective room. who are the audients in the room? i guess it is api.ts
    //TODO low: to confirm the room' name by cross checking on the subscribers' side
    
    //checking tx
    const retryTxCursor = async () => {
      logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 10`);
      const txCursor = EventModel.getTxTail(lastTxUpdate);
      while (await txCursor.hasNext()) {
        const txEvent = await txCursor.next();
        //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 11 - got next tx event`);
        if (this.io && txEvent) {
          //a typical document in events collection
          //{
          //  "_id":"5c06c29f103d912493c95082",
          //  "type":"tx",
          //  "emitTime":"2018-12-04T18:08:31.535Z",
          //  "payload":{
          //    "chain":"BTC",
          //    "network":"testnet",
          //    "blockHeight":-1,"blockHash":null,"blockTime":"2018-12-04T18:08:31.428Z","blockTimeNormalized":"2018-12-04T18:08:31.428Z","coinbase":false,
          //    "fee":39300,"size":391,"locktime":0,"value":10978792,"wallets":[],"txid":"5a620675c178fac3dd52dd4f07e9dab8a8a9b99623a6594e25135330ae7c9cff"
          //  }
          //}
          const tx = <IEvent.TxEvent>txEvent.payload;
          const { chain, network } = tx;
          //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 12`);
          //sending a 'tx' event with payload tx, to all clients in '...' room, including the sender
          //seems the room is the same across all 3 diff categories...
          this.io.sockets.in(`/${chain}/${network}/inv`).emit('tx', tx);
          lastTxUpdate = new Date();
        }
      }
      //call retryTxCursor func after 5s, call only once
      //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 13`);
      setTimeout(retryTxCursor, 5000);
      //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 14`);
    };
    retryTxCursor();

    //checking block
    const retryBlockCursor = async () => {
      logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 20`);
      const blockCursor = EventModel.getBlockTail(lastBlockUpdate);
      while (await blockCursor.hasNext()) {
        const blockEvent = await blockCursor.next();
        //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 21 - get next block event`);
        if (this.io && blockEvent) {
          const block = <IEvent.BlockEvent>blockEvent.payload;
          const { chain, network } = block;
          //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 22`);
          this.io.sockets.in(`/${chain}/${network}/inv`).emit('block', block);
          lastBlockUpdate = new Date();
        }
      }
      //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 23`);
      setTimeout(retryBlockCursor, 5000);
      //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 24`);
    };
    retryBlockCursor();

    //TODO low: what is address tx
    //checking address tx
    const retryAddressTxCursor = async () => {
      logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 30`);
      const addressTxCursor = EventModel.getCoinTail(lastAddressTxUpdate);
      while (await addressTxCursor.hasNext()) {
        const addressTx = await addressTxCursor.next();
        //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 31 - get next addr tx event`);
        if (this.io && addressTx) {
          const { address, coin } = <IEvent.CoinEvent>addressTx.payload;
          const { chain, network } = coin;
          //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 32`);
          this.io.sockets.in(`/${chain}/${network}/address`).emit(address, coin);
          //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 33`);
          this.io.sockets.in(`/${chain}/${network}/inv`).emit('coin', coin);
          lastAddressTxUpdate = new Date();
        }
      }
      //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 34`);
      setTimeout(retryAddressTxCursor, 5000);
      //logger.debug(`YCM TRACKER === services/socket.ts wireupCursors() 35`);
    };
    retryAddressTxCursor();
  }

  //leveraging on models/events.ts (which represents the 'events' collection in db)
  //to signal an event, in the form of inserting a record 

  //the following 3 funcs are called by block.ts / transaction.ts
  //to insert the event into the 'events' collection in the db
  //by doing so, it effectively 'signals' the data monitor that there are some new data, pls work on them
  //just happen that, the data monitor is also this socket.ts itself, 
  //the monitoring part is implemented in wireupCursors()

  //insert a doc record to db's event collection
  //called in block.ts near the end of addBlock()
  async signalBlock(block: IEvent.BlockEvent) {
    await EventModel.signalBlock(block);
  }
  //called in transaction.ts near the end of batchImport()
  async signalTx(tx: IEvent.TxEvent) {
    await EventModel.signalTx(tx);
  }
  //called in transaction.ts near the end of batchImport()
  async signalAddressCoin(payload: IEvent.CoinEvent) {
    await EventModel.signalAddressCoin(payload);
  }
}

export const Socket = new SocketService();
