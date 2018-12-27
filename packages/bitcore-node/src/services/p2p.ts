import config from '../config';
import logger from '../logger';
import { EventEmitter } from 'events';
import { BlockModel } from '../models/block';
import { ChainStateProvider } from '../providers/chain-state';
import { TransactionModel } from '../models/transaction';
import { Bitcoin } from '../types/namespaces/Bitcoin';
import { StateModel } from '../models/state';
import { SpentHeightIndicators } from '../types/Coin';

import { LoggifyClass } from '../decorators/Loggify';

const Chain = require('../chain');
const LRU = require('lru-cache');

@LoggifyClass
export class P2pService {
  private chain: string;
  private network: string;
  private bitcoreLib: any;
  private bitcoreP2p: any;
  private chainConfig: any;
  private events: EventEmitter;
  private syncing: boolean;
  private messages: any;
  private pool: any;
  private invCache: any;
  private initialSyncComplete: boolean;

  constructor(params) {
    const { chain, network, chainConfig } = params;
    this.chain = chain;
    this.network = network;
    //because src/chain.ts defines Chain[BTC].lib: require('bitcore-lib')
    //so this.bitcoreLib = require('bitcore-lib')
    this.bitcoreLib = Chain[this.chain].lib;
    //similarily, bitcoreP2p = require('bitcore-p2p')
    this.bitcoreP2p = Chain[this.chain].p2p;
    this.chainConfig = chainConfig;
    //TODO low: to find out, besides this instance itself, who are subscribers/consumers of the events here?
    //it seems that this events is for this p2p instance's internal event driven communications
    this.events = new EventEmitter();
    this.syncing = false;
    this.initialSyncComplete = false;
    this.invCache = new LRU({ max: 10000 });
    //bitcore-p2p.index.ts defines Messages require('./messages'), which is bitcore-p2p/lib/messages
    //bitcore-p2p/lib/messages/index.js : 'Messages' is a a factory to build Bitcoin protocol messages.
    //this line of code constructs a message builder which is capable of producing new messages whenever needed
    //a runtime message object created by this.messages is often sent out via this.pool.sendMessage(...)
    this.messages = new this.bitcoreP2p.Messages({
      network: this.bitcoreLib.Networks.get(this.network)
    });
    //similarily, Pool refers to bitcore-p2p/lib/pool.js
    //the pool will discover peers from DNS seeds, will collect info about new peers etc
    //note the config below, it means if needed we are able to enable dnsSeed and start listening
    this.pool = new this.bitcoreP2p.Pool({
      addrs: this.chainConfig.trustedPeers.map(peer => {
        return {
          ip: {
            v4: peer.host
          },
          port: peer.port
        };
      }),
      dnsSeed: false,
      listenAddr: false,
      network: this.network,
      messages: this.messages
    });
  }

  //we register all listeners for this.pool
  //register all private handlers for events from _pool
  //when there is a new peer ready, or a peer disconnected, we print the info
  //when there is a peer new inventory event, we check if we have all the inventory, if not we ask for those missing ones from the same peer
  //when there is a transaction from our peer, we broadcast to our subscribers (by publishing a 'p2p/transaction' event)
  //when there is a block from our peer, we broadcast to our subscribers (by publishing a 'p2p/block' event)
  //when there is a header from our peer, we broadcast to our subscribers (by publishing a 'p2p/headers' event)
  setupListeners() {
    this.pool.on('peerready', peer => {
      logger.info(`services/p2p.ts Connected to peer ${peer.host}`, {
        chain: this.chain,
        network: this.network
      });
    });

    this.pool.on('peerdisconnect', peer => {
      logger.warn(`services/p2p.ts Not connected to peer ${peer.host}`, {
        chain: this.chain,
        network: this.network,
        port: peer.port
      });
    });

    //if we get a tx from the peer, if we dont have it, we process it, and put it to invCache
    //for a tx message, the actual data is in message.transaction
    this.pool.on('peertx', (peer, message) => {
      const hash = message.transaction.hash;
      logger.info(`YCM services/p2p.ts peertx message received`);
      logger.debug('YCM services/p2p.ts services/p2p.ts peer tx received', {
        peer: `${peer.host}:${peer.port}`,
        chain: this.chain,
        network: this.network,
        hash
      });
      //if we dont have it in our cache, process the tx and fire a 'transaction' event
      if (!this.invCache.get(hash)) {
        //essentially do a TransactionModel.batchImport on the given tx
        this.processTransaction(message.transaction);
        //i dont think there is any consumer to this event in non-testing code
        this.events.emit('transaction', message.transaction);
      }
      //we save it, mark this hash as 'recently-used'
      this.invCache.set(hash);
    });

    //for a block message, the actual data is in message.block
    //one biz scenario that will lead of firing of this event is:
    //- when we start bitcore-node, our sync() func find out there are 3 new blocks to sync, it then call this.getBlock(header.hash) for 3 times to get all 3 blocks
    //  then in getBlock(), we have code like: 
    //    this.pool.sendMessage(this.messages.GetData.forBlock(hash));  //actually getting the single block
    //    this.events.once(hash, block => {...}   //register a event listener to wait for this particular block, using the block hash as the event name, and process the block only once when it arrives
    this.pool.on('peerblock', async (peer, message) => {
      const { block } = message;
      const { hash } = block;

      logger.info(`YCM services/p2p.ts peerblock message received`);
      logger.debug('services/p2p.ts peer block received', {
        peer: `${peer.host}:${peer.port}`,
        chain: this.chain,
        network: this.network,
        hash
      });
      
      //if not found in cache, we work on this block, otherwise we totally ignore the block, hmmm...
      if (!this.invCache.get(hash)) {
        this.invCache.set(hash);
        //look carefully this if block, we emit two events, 
        //the first event, with key = acutalBlockHash, the target audience is the getBlock() function who request for this block by this.pool.sendMessage(this.messages.GetData.forBlock(hash))
        //the second event, with key = 'block', this is a general purpose event, which is not meant to the original block requester

        //fire a event with event name = block hash, any consumer???
        logger.info('YCM services/p2p.ts peerblock notify subscribers on a specific blockhash event, with targeted audience');
        this.events.emit(hash, message.block);

        //i dont think there is any consumer to this event in non-testing code
        //TODO low: check bitcore v5 p2p comment to see who are the subscribers
        logger.info('YCM services/p2p.ts peerblock notify subscribers on a block event, with general audience (seems no audience interested)');
        this.events.emit('block', message.block);
        //since this is a new block, we call sync() to sync (all the real dirty work)
        this.sync();
      }
    });
    
    //for a headers message, the actual data is in message.headers
    this.pool.on('peerheaders', (peer, message) => {
      logger.info(`YCM services/p2p.ts peerheaders message received`);
      logger.debug('services/p2p.ts peerheaders message received', {
        peer: `${peer.host}:${peer.port}`,
        chain: this.chain,
        network: this.network,
        count: message.headers.length
      });
      logger.info(`YCM services/p2p.ts peerheaders notify subscribers on a headers event`);
      this.events.emit('headers', message.headers);
    });

    //only when 'syncing' flag is false, we will deal with this event
    //syncing is set to true when 
    //- bitcore-node is started, syncing is set back to false when the height is in sync with peers
    //- this p2p instance got a peerblock event from the pool (p2p is a subscriber of its pool instance) and find out that this new block is indeed a new block, therefore invoke sync()
    this.pool.on('peerinv', (peer, message) => {
      logger.info(`YCM services/p2p.ts peerinv message received`);
      //if the syncing is already in progres, we ignore the inv event
      if (!this.syncing) {
        const filtered = message.inventory.filter(inv => {
          const hash = this.bitcoreLib.encoding
            .BufferReader(inv.hash)
            .readReverse()
            .toString('hex');
           //if we have this hash in our invCache, we return false
          return !this.invCache.get(hash);
        });

        //if we dont have this inventory in our cache, we request for it, via sending GetData to our peer
        if (filtered.length) {
          logger.info(`YCM services/p2p.ts peerinv requesting for the data that inv represents`);
          peer.sendMessage(this.messages.GetData(filtered));
        }
      }
    });
  }

  async connect() {
    //pool.connect() get the pool object (representing a collection of peers) connect to those peers
    this.pool.connect();
    //https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_objects/Function/bind
    //bind() creates a new function that, when called, has its this keyword set to the provided value, with a given sequence of arguments preceding any provided when the new function is called.
    //TODO low: why do we need the line below? isn't the line above this.pool.connect() enough?
    setInterval(this.pool.connect.bind(this.pool), 5000);
    //my understanding:
    //if the pool gets a 'peerready' event, we (the p2p) mark connect() as resolve
    //of course we want this marking to be done only once
    return new Promise<void>(resolve => {
      //we got a peerready event, we now mark connect() as resolve`);
      this.pool.once('peerready', () => resolve());
    });
  }

  static startConfiguredChains() {
    logger.info(`YCM services/p2p.ts startConfiguredChains() creating a p2pservice instance for each registered chain-network pair`);
    for (let chain of Object.keys(config.chains)) {
      for (let network of Object.keys(config.chains[chain])) {
        const chainConfig = config.chains[chain][network];
        //if it is not p2p, not my business, pass
        if (chainConfig.chainSource && chainConfig.chainSource !== 'p2p') {
          continue;
        }
        logger.info(`YCM services/p2p.ts startConfiguredChains() starting p2pservice for ${chain} ${network}`);
        new P2pService({
          chain,
          network,
          chainConfig
        }).start();
      }
    }
  }

  public async getHeaders(candidateHashes: string[]): Promise<Bitcoin.Block.HeaderObj[]> {
    return new Promise<Bitcoin.Block.HeaderObj[]>(resolve => {
      logger.info(`YCM TRACKER === services/p2p.ts getHeaders() 1`);
      //a private function
      const _getHeaders = () => {
        //after constructing the message, we send it to the peers (i.e. the pool)
        this.pool.sendMessage(
          //candidateHashes = the most 30 locally processed blocks
          //see https://bitcoin.org/en/developer-reference#getheaders
          //the getheaders/getblocks rpc command allows the requesting peer (which is 'this') to provide multiple header hashes (which is the last 30) on their local chain. 
          //This allows the receiving peer to find, within that list, the last header hash they had in common and reply with all subsequent header hashes.
          //==> so my conclusion is, the headers returned by the pool is any newer blocks that this node has not seen. if there is any reorg, those blocks will be sent as well
          //==> we can safely assume all those headers/blocks to be received need to be processed
          this.messages.GetHeaders({
            starts: candidateHashes
          })
        );
      };
      logger.info(`YCM TRACKER === services/p2p.ts getHeaders() 2`);
      //start getting headers after 1s and keep retrying every second
      const headersRetry = setInterval(_getHeaders, 1000);

      logger.info(`YCM TRACKER === services/p2p.ts getHeaders() 3`);
      //register a event listener, i.e. when there is a 'headers' event, we will process headers accordingly
      //EventEmitter.once is an alias of EventEmitter.addEventListener. works exactly the same but will always pass true for the last argument which causes the event to only run once.
      this.events.once('headers', headers => {
        //we ask the retry to stop since we got the reply (ie 'headers' event)
        clearInterval(headersRetry);
        //callback/return with the ACTUAL data: headers
        resolve(headers);
      });
      logger.info(`YCM TRACKER === services/p2p.ts getHeaders() 4`);
      //we immediately _getHeaders, the headersRetry will help us retry but we want to call the func early
      _getHeaders();
      logger.info(`YCM TRACKER === services/p2p.ts getHeaders() 5`);
    });
  }

  public async getBlock(hash: string) {
    return new Promise(resolve => {
      logger.info(`YCM TRACKER === services/p2p.ts getBlock() 1 - begin`);

      logger.info('YCM services/p2p.ts getBlock() going to get block with hash in a second:', hash);
      logger.debug('Getting block, hash:', hash);

      //from the log print, it seems that _getBlock() is not invoked by the line 'const getBlockRetry...'
      //it seems to get only invoked in the last statement of this function '_getBlock()'
      //so my temp conclusion is:
      //- we declare _getBlock and getBlockRetry first
      //- we call getBlockRetry only (and only once) when we receive the block hash we ask for
      const _getBlock = () => {
        logger.info(`YCM TRACKER === services/p2p.ts getBlock() 4`);
        this.pool.sendMessage(this.messages.GetData.forBlock(hash));
      };
      //this call will be called after 1s, and get repeated every 1s thereafter
      const getBlockRetry = setInterval(_getBlock, 1000);

      logger.info(`YCM TRACKER === services/p2p.ts getBlock() 2`);
      //the code this.pool.on('peerblock'... will trigger the listener/handler below
      //EventEmitter.once is an alias of EventEmitter.addEventListener. works exactly the same but will always pass true for the last argument which causes the event to only run once.
      //here we are registering a special short-lived listener to process the block with block hash = hash
      this.events.once(hash, block => {
        logger.info(`YCM TRACKER === services/p2p.ts getBlock() 6`);
        logger.info('YCM services/p2p.ts getBlock() received block with hash:', hash);
        logger.debug('Received block, hash:', hash);
        //we ask the setInterval to stop since we got the reply
        clearInterval(getBlockRetry);
        //callback/return with the ACTUAL data: block
        logger.info(`YCM TRACKER === services/p2p.ts getBlock() 7 - resolve`);
        logger.info('YCM services/p2p.ts getBlock() mark getBlock as resolved');
        resolve(block);
      });
      logger.info(`YCM TRACKER === services/p2p.ts getBlock() 3`);
      //though we setup getBlockRetry(), we still want to call _getBlock() early
      _getBlock();
      logger.info(`YCM TRACKER === services/p2p.ts getBlock() 5 - end`);
    });
  }

  getBestPoolHeight(): number {
    let best = 0;
    for (const peer of Object.values(this.pool._connectedPeers) as { bestHeight: number }[]) {
      if (peer.bestHeight > best) {
        best = peer.bestHeight;
      }
    }
    return best;
  }

  //TODO low: initialSyncComplete is set to this.initialSyncComplete while in processTransaction() it is always set to true, why?
  async processBlock(block): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        logger.info(`YCM TRACKER === services/p2p.ts processBlock() 1`);
        //add the block to the db
        await BlockModel.addBlock({
          chain: this.chain,
          network: this.network,
          forkHeight: this.chainConfig.forkHeight,
          parentChain: this.chainConfig.parentChain,
          initialSyncComplete: this.initialSyncComplete,
          block
        });

        logger.info(`YCM TRACKER === services/p2p.ts processBlock() 2`);
        logger.info(`YCM services/p2p.ts processBlock() BlockModel added block ${block.hash}`, { chain: this.chain, network: this.network });
        if (!this.syncing) {
          logger.info(`Added block ${block.hash}`, {
            chain: this.chain,
            network: this.network
          });
        }
        logger.info(`YCM TRACKER === services/p2p.ts processBlock() 3`);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  async processTransaction(tx: Bitcoin.Transaction): Promise<any> {
    const now = new Date();
    TransactionModel.batchImport({
      chain: this.chain,
      network: this.network,
      txs: [tx],
      height: SpentHeightIndicators.pending,
      mempoolTime: now,
      blockTime: now,
      blockTimeNormalized: now,
      initialSyncComplete: true
    });
  }

  async sync() {
    //if the flag is already set to true, we skil this round
    if (this.syncing) {
      return;
    }
    logger.info(`YCM TRACKER === services/p2p.ts sync() 1 - begin (this is a long func call)`);
    //mark it as true and remain active while we are still syncing with peers
    this.syncing = true;
    //i guess this copy the variables at the instance level to within the function
    const { chain, chainConfig, network } = this;
    const { parentChain, forkHeight } = chainConfig;
    //the 'state' here represents the data in mongodb
    //StateModel.collection fetches all the state data from the database, findOne() return the first matching result
    const state = await StateModel.collection.findOne({});
    //if in the mongodb, there is a record "BTC:testnet" under 'initialSyncComplete', we say initialSyncComplete is true
    this.initialSyncComplete =
      state && state.initialSyncComplete && state.initialSyncComplete.includes(`${chain}:${network}`);
    //get the tip (block with highest height) locally (which may or may not be the global tip)
    let tip = await ChainStateProvider.getLocalTip({ chain, network });
    //if parent chain tip has a lower height than the fork height, we sync parent first, put child on hold (recheck every 5s)
    if (parentChain && (!tip || tip.height < forkHeight)) {
      let parentTip = await ChainStateProvider.getLocalTip({ chain: parentChain, network });
      while (!parentTip || parentTip.height < forkHeight) {
        logger.info(`Waiting until ${parentChain} syncs before ${chain} ${network}`);
        await new Promise(resolve => {
          setTimeout(resolve, 5000);
        });
        parentTip = await ChainStateProvider.getLocalTip({ chain: parentChain, network });
      }
    }

    //define a async func, which takes no param
    const getHeaders = async () => {
      //block->blockHash map for the most recent 30 processed blocks
      const locators = await ChainStateProvider.getLocatorHashes({ chain, network });
      //we share our best knowledge with peers, the 30 recent blocks' hashes, and want to get headers info of all newer blocks, if any
      return this.getHeaders(locators);
    };

    //we have a set of headers to process
    let headers = await getHeaders();
    while (headers.length > 0) {
      //now we know we have some new headers to process
      //get the tip again
      tip = await ChainStateProvider.getLocalTip({ chain, network });
      let currentHeight = tip ? tip.height : 0;
      let lastLog = 0;
      logger.info(`Syncing ${headers.length} blocks for ${chain} ${network}`);
      logger.info(`YCM TRACKER === services/p2p.ts sync() 2`);
      for (const header of headers) {
        try {
          logger.info(`YCM TRACKER === services/p2p.ts sync() 3 - for the next new header`);
          //for each header hash, get the block data
          const block = await this.getBlock(header.hash);
          logger.info(`YCM TRACKER === services/p2p.ts sync() 4`);
          //process the block by adding it to mongodb
          //if we trace the code we will find out if the mongodb fails to add the block to db, the promise (in block.ts) turns to a reject,
          //which then get caught in the processBlock() and turns to a reject there. When the flow is back to this func, the error is caught by
          //the catch(err) a few lines below and that print the error, mark sync as false, and return this.sync(), this means it attempt to retry sync() again (i think)
          await this.processBlock(block);
          logger.info(`YCM TRACKER === services/p2p.ts sync() 5`);
          currentHeight++;
          logger.info(`YCM services/p2p.ts sync() after processing a new block, latest height is ${currentHeight}`);
          //for at least every 0.1s , we log a sync message
          if (Date.now() - lastLog > 100) {
            logger.info(`Sync ==> `, { chain, network, height: currentHeight });
            lastLog = Date.now();
          }
        } catch (err) {
          logger.error(`Error syncing ${chain} ${network}`, err);
          this.syncing = false;
          return this.sync();
        }
      }
      headers = await getHeaders();
    }
    logger.info(`YCM TRACKER === services/p2p.ts sync() 6`);
    //up to this point, we know we are up to date
    logger.info(`${chain}:${network} up to date.`);
    this.syncing = false;
    StateModel.collection.findOneAndUpdate(
      {},
      { $addToSet: { initialSyncComplete: `${chain}:${network}` } },
      { upsert: true }
    );
    logger.info(`YCM TRACKER === services/p2p.ts sync() 7 - end`);
    return true;
  }

  async start() {
    logger.info(`YCM TRACKER === services/p2p.ts start() 1 - p2p service starting for chain ${this.chain} ${this.network} ${this.chainConfig}`);
    //register listeners first, prior to connect()
    logger.info(`YCM TRACKER === services/p2p.ts start() 2 - setting up the listeners, so that we are ready to act on peer events`);
    this.setupListeners();
    logger.info(`YCM TRACKER === services/p2p.ts start() 3 - connecting to the pool (bitcore-p2p/pool.js)`);
    await this.connect();
    logger.info(`YCM TRACKER === services/p2p.ts start() 4 - starting syncing process`);
    this.sync();
    logger.info(`YCM TRACKER === services/p2p.ts start() 5 - end`);
  }
}
