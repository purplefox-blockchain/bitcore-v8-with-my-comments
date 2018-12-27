import { CoinModel } from './coin';
import { TransactionModel } from './transaction';
import { TransformOptions } from '../types/TransformOptions';
import { LoggifyClass } from '../decorators/Loggify';
import { Bitcoin } from '../types/namespaces/Bitcoin';
import { BaseModel, MongoBound } from './base';
import logger from '../logger';
import { IBlock } from '../types/Block';
import { Socket } from '../services/socket';
import { SpentHeightIndicators } from '../types/Coin';

export { IBlock };

@LoggifyClass
export class Block extends BaseModel<IBlock> {
  constructor() {
    super('blocks');
  }

  allowedPaging = [
    {
      key: 'height' as 'height',
      type: 'number' as 'number'
    }
  ];

  async onConnect() {
    logger.info(`YCM models/block.ts onConnect()`);
    //try to create index in background, this func is also used to ensure the index creation
    //1 for ascending index, -1 for descending index
    this.collection.createIndex({ hash: 1 }, { background: true });
    this.collection.createIndex({ chain: 1, network: 1, processed: 1, height: -1 }, { background: true });
    this.collection.createIndex({ chain: 1, network: 1, timeNormalized: 1 }, { background: true });
    this.collection.createIndex({ previousBlockHash: 1 }, { background: true });
  }

  async addBlock(params: {
    block: any;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
  }) {
    const { block, chain, network, parentChain, forkHeight, initialSyncComplete } = params;
    const header = block.header.toObject();
    const blockTime = header.time * 1000;

    //TODO low: we ignore reorg for now
    const reorg = await this.handleReorg({ header, chain, network });

    if (reorg) {
      return Promise.reject('reorg');
    }

    //use the hash (one of the index of the blocks collection) to search for the prev block
    const previousBlock = await this.collection.findOne({ hash: header.prevHash, chain, network });

    //TODO low: not sure 'normalized' means'
    //if the block time taken from block.header is after prevBlock's time,
    //this block's time is set to the time recorded from the block.header
    const blockTimeNormalized = (() => {
      const prevTime = previousBlock ? previousBlock.timeNormalized : null;
      if (prevTime && blockTime <= prevTime.getTime()) {
        return prevTime.getTime() + 1;
      } else {
        return blockTime;
      }
    })();

    //setting the height++
    const height = (previousBlock && previousBlock.height + 1) || 1;
    logger.debug('Setting blockheight', height);

    //the sample data is from btc testnet, taken from my mac local mongodb
    //_id:                  5c1078ba81bdae25640b0147  (an auto generated id?)
    //chain:                BTC
    //network:              testnet
    //hash:                 00000000000000bceb8cfb04065a55db0e24fd81879fa22da8a2cbaa8ee301d6
    //height:               1447462
    //version:              536928256 (should be converted to 0x, as what other explores do)
    //previousBlockHash:    0000000000049b697c490d1a8ff3b8ba03d95f8430506f03841c6d219f791bdb
    //merkleRoot:           580039d2d0fcc38f5548230552c5d27f9bd6a8fbd41ebfe073197624935d4a5a
    //time:                 2018-12-12T02:51:04.000Z
    //timeNormalized:       2018-12-12T02:51:04.000Z
    //bits:                 436289080
    //nonce:                472380215
    //transactionCount:     16
    //size:                 3817 (bytes)
    //reward:               78206699  (this is the coinbase tx's output, the block reward is 0.78125BTC, plus all the tx fee, making it 0.78206699BTC)
    //processed:            true      (this is added later)
    //To verify the same info, visit blockcypher at https://live.blockcypher.com/btc-testnet/block/00000000000000bceb8cfb04065a55db0e24fd81879fa22da8a2cbaa8ee301d6/
    //the above transaction with rewar
    const convertedBlock = {
      chain,
      network,
      hash: block.hash,
      height,
      version: header.version,
      previousBlockHash: header.prevHash,
      merkleRoot: header.merkleRoot,
      time: new Date(blockTime),
      timeNormalized: new Date(blockTimeNormalized),
      bits: header.bits,
      nonce: header.nonce,
      transactionCount: block.transactions.length,
      size: block.toBuffer().length,
      reward: block.transactions[0].outputAmount
    };
    //update the block itself, when no doc found, create a new doc 
    //update a single document, syntax: updateOne(filterToSelectDoc, updateOperations, options)
    //my understanding of the 3 args below are: select {...} do {...} with option {...}
    //when upsert is set to true = update OR insert, not the default behavior
    await this.collection.updateOne(
      { hash: header.hash, chain, network },
      {
        $set: convertedBlock
      },
      { upsert: true }
    );

    //update prev block's nextBlockHash
    if (previousBlock) {
      await this.collection.updateOne(
        { chain, network, hash: previousBlock.hash },
        { $set: { nextBlockHash: header.hash } }
      );
      logger.debug('Updating previous block.nextBlockHash ', header.hash);
    }

    //process all tx in this block
    await TransactionModel.batchImport({
      txs: block.transactions,
      blockHash: header.hash,
      blockTime: new Date(blockTime),
      blockTimeNormalized: new Date(blockTimeNormalized),
      height: height,
      chain,
      network,
      parentChain,
      forkHeight,
      initialSyncComplete
    });

    //except for the very first sync, we want to signal the arrival of a new block to api.ts
    if (initialSyncComplete) {
      Socket.signalBlock(convertedBlock);
    }

    //when everything is done, mark this block as processed in the db
    return this.collection.updateOne({ hash: header.hash, chain, network }, { $set: { processed: true } });
  }

  getPoolInfo(coinbase: string) {
    //below are developer's comment and todo
    //TODO need to make this actually parse the coinbase input and map to miner strings
    // also should go somewhere else
    return coinbase;
  }

  getLocalTip({ chain, network }) {
    return BlockModel.collection.findOne({ chain, network, processed: true }, { sort: { height: -1 } });
  }

  async handleReorg(params: { header?: Bitcoin.Block.HeaderObj; chain: string; network: string }): Promise<boolean> {
    const { header, chain, network } = params;
    let localTip = await this.getLocalTip(params);
    if (header && localTip && localTip.hash === header.prevHash) {
      return false;
    }
    if (!localTip || localTip.height === 0) {
      return false;
    }
    if (header) {
      const prevBlock = await this.collection.findOne({ chain, network, hash: header.prevHash });
      if (prevBlock) {
        localTip = prevBlock;
      } else {
        logger.error(`Previous block isn't in the DB need to roll back until we have a block in common`);
      }
    }
    logger.info(`Resetting tip to ${localTip.height}`, { chain, network });
    const reorgOps = [
      this.collection.deleteMany({ chain, network, height: { $gte: localTip.height } }),
      TransactionModel.collection.deleteMany({ chain, network, blockHeight: { $gte: localTip.height } }),
      CoinModel.collection.deleteMany({ chain, network, mintHeight: { $gte: localTip.height } })
    ];
    await Promise.all(reorgOps);

    await CoinModel.collection.updateMany(
      { chain, network, spentHeight: { $gte: localTip.height } },
      { $set: { spentTxid: null, spentHeight: SpentHeightIndicators.pending } }
    );

    logger.debug('Removed data from above blockHeight: ', localTip.height);
    return true;
  }

  //transform an object to a json string?
  //this func is called by providers/chain-state/internal/internal.ts/async getBlocks(params: CSP.GetBlockParams) {...}
  //https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify
  //JSON.stringify() method converts a JavaScript object or value to a JSON string
  _apiTransform(block: Partial<MongoBound<IBlock>>, options: TransformOptions): any {
    const transform = {
      _id: block._id,
      chain: block.chain,
      network: block.network,
      hash: block.hash,
      height: block.height,
      version: block.version,
      size: block.size,
      merkleRoot: block.merkleRoot,
      time: block.time,
      timeNormalized: block.timeNormalized,
      nonce: block.nonce,
      bits: block.bits,
      /*
       *difficulty: block.difficulty,
       */
      /*
       *chainWork: block.chainWork,
       */
      previousBlockHash: block.previousBlockHash,
      nextBlockHash: block.nextBlockHash,
      reward: block.reward,
      /*
       *isMainChain: block.mainChain,
       */
      transactionCount: block.transactionCount
      /*
       *minedBy: BlockModel.getPoolInfo(block.minedBy)
       */
    };
    if (options && options.object) {
      return transform;
    }
    return JSON.stringify(transform);
  }
}

export let BlockModel = new Block();
