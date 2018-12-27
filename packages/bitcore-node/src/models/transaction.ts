import { CoinModel } from './coin';
import { WalletAddressModel } from './walletAddress';
import { partition } from '../utils/partition';
import { ObjectID } from 'bson';
import { TransformOptions } from '../types/TransformOptions';
import { LoggifyClass } from '../decorators/Loggify';
import { Bitcoin } from '../types/namespaces/Bitcoin';
import { BaseModel, MongoBound } from './base';
import logger from '../logger';
import config from '../config';
import { StreamingFindOptions, Storage } from '../services/storage';
import * as lodash from 'lodash';
import { Socket } from '../services/socket';
import { TransactionJSON } from '../types/Transaction';
import { SpentHeightIndicators } from '../types/Coin';

import util from 'util';

const Chain = require('../chain');

export type ITransaction = {
  txid: string;
  chain: string;
  network: string;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: Date;
  blockTimeNormalized?: Date;
  coinbase: boolean;
  fee: number;
  size: number;
  locktime: number;
  inputCount: number;
  outputCount: number;
  value: number;
  wallets: ObjectID[];
};

@LoggifyClass
export class Transaction extends BaseModel<ITransaction> {
  constructor() {
    super('transactions');
  }

  allowedPaging = [
    { key: 'blockHash' as 'blockHash', type: 'string' as 'string' },
    { key: 'blockHeight' as 'blockHeight', type: 'number' as 'number' },
    { key: 'blockTimeNormalized' as 'blockTimeNormalized', type: 'date' as 'date' },
    { key: 'txid' as 'txid', type: 'string' as 'string' }
  ];

  onConnect() {
    logger.info(`YCM models/transaction.ts onConnect()`);
    this.collection.createIndex({ txid: 1 }, { background: true });
    this.collection.createIndex({ chain: 1, network: 1, blockHeight: 1 }, { background: true });
    this.collection.createIndex({ blockHash: 1 }, { background: true });
    this.collection.createIndex({ chain: 1, network: 1, blockTimeNormalized: 1 }, { background: true });
    this.collection.createIndex(
      { wallets: 1, blockTimeNormalized: 1 },
      { background: true, partialFilterExpression: { 'wallets.0': { $exists: true } } }
    );
    this.collection.createIndex(
      { wallets: 1, blockHeight: 1 },
      { background: true, partialFilterExpression: { 'wallets.0': { $exists: true } } }
    );
  }

  //TODO high: to finish reading this
  //transaction batch import func are called by two places, 
  //- block.ts, as part of a new block, its transactions, thousands of them (in mainnet), need to be processed
  //- p2p.ts i think it is mainly the uncomfirmed transaction, that will go to mempool
  //they will have very different passed-in params, some params are left as empty
  async batchImport(params: {
    txs: Array<Bitcoin.Transaction>;  //all tx in the block (for block) or single tx (for p2p)
    height: number;                   //actual height (for block) or SpentHeightIndicators.pending (for p2p)
    mempoolTime?: Date;               //missing for both block and p2p
    blockTime?: Date;                 //blockTime (for block) or now (for p2p)
    blockHash?: string;               //missing when calling from p2p
    blockTimeNormalized?: Date;       ////blockTimeNormalized (for block) or now (for p2p)
    parentChain?: string;             //missing when calling from p2p
    forkHeight?: number;              //missing when calling from p2p
    chain: string;                    //obvious
    network: string;                  //obvious
    initialSyncComplete: boolean;     //actual flag value when calling from block, true when calling from p2p
  }) {
    logger.info(`YCM TRACKER *** models/transaction.ts batchImport()`);
    logger.info(`YCM TRACKER *** models/transaction.ts batchImport() - processing outputs first...`);
    const mintOps = await this.getMintOps(params);
    logger.info(`YCM TRACKER *** models/transaction.ts batchImport() - processing inputs next...`);
    const spendOps = this.getSpendOps({ ...params, mintOps });
    logger.info(`YCM TRACKER *** models/transaction.ts batchImport() - pruning mempool...`);
    await this.pruneMempool({ ...params, mintOps, spendOps });

    //YCM temp comment out
    //logger.debug('Minting Coins', mintOps.length);
    if (mintOps.length) {
      logger.info(`YCM models/transaction.ts batchImport() - starting bulkWrite outputs (size: ${mintOps.length}) to db...`);
      await Promise.all(
        partition(mintOps, mintOps.length / config.maxPoolSize).map(mintBatch =>
          CoinModel.collection.bulkWrite(mintBatch, { ordered: false })
        )
      );
    }

    //YCM temp comment out
    //logger.debug('Spending Coins', spendOps.length);
    if (spendOps.length) {
      logger.info(`YCM models/transaction.ts batchImport() - starting bulkWrite inputs (size: ${spendOps.length}) to db...`);
      await Promise.all(
        partition(spendOps, spendOps.length / config.maxPoolSize).map(spendBatch =>
          CoinModel.collection.bulkWrite(spendBatch, { ordered: false })
        )
      );
    }

    if (mintOps) {
      const txOps = await this.addTransactions({ ...params, mintOps });
      logger.info(`YCM models/transaction.ts batchImport() - starting bulkWrite txs (size: ${txOps.length}) to db...`);
      //YCM temp comment out
      //logger.debug('Writing Transactions', txOps.length);
      await Promise.all(
        partition(txOps, txOps.length / config.maxPoolSize).map(txBatch =>
          this.collection.bulkWrite(txBatch, { ordered: false })
        )
      );

      // Create events for mempool txs
      if (params.height < SpentHeightIndicators.minimum) {
        txOps.forEach(op => {
          const filter = op.updateOne.filter;
          const tx = { ...op.updateOne.update.$set, ...filter };
          Socket.signalTx(tx);
          mintOps
            .filter(coinOp => coinOp.updateOne.filter.mintTxid === filter.txid)
            .forEach(coinOp => {
              const address = coinOp.updateOne.update.$set.address;
              const coin = { ...coinOp.updateOne.update.$set, ...coinOp.updateOne.filter };
              Socket.signalAddressCoin({ address, coin });
            });
        });
      }
    }

    logger.info(`YCM TRACKER === models/transaction.ts batchImport() - end`);
  }

  async addTransactions(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    blockTime?: Date;
    blockHash?: string;
    blockTimeNormalized?: Date;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
    mintOps: Array<any>;
    mempoolTime?: Date;
  }) {
    let { blockHash, blockTime, blockTimeNormalized, chain, height, network, parentChain, forkHeight } = params;
    if (parentChain && forkHeight && height < forkHeight) {
      const parentTxs = await TransactionModel.collection
        .find({ blockHeight: height, chain: parentChain, network })
        .toArray();
      return parentTxs.map(parentTx => {
        return {
          updateOne: {
            filter: { txid: parentTx.txid, chain, network },
            update: {
              $set: {
                chain,
                network,
                blockHeight: height,
                blockHash,
                blockTime,
                blockTimeNormalized,
                coinbase: parentTx.coinbase,
                fee: parentTx.fee,
                size: parentTx.size,
                locktime: parentTx.locktime,
                inputCount: parentTx.inputCount,
                outputCount: parentTx.inputCount,
                value: parentTx.value,
                wallets: []
              }
            },
            upsert: true,
            forceServerObjectId: true
          }
        };
      });
    } else {
      let spentQuery;
      if (height > 0) {
        spentQuery = { spentHeight: height, chain, network };
      } else {
        spentQuery = { spentTxid: { $in: params.txs.map(tx => tx._hash) }, chain, network };
      }
      const spent = await CoinModel.collection
        .find(spentQuery)
        .project({ spentTxid: 1, value: 1, wallets: 1 })
        .toArray();
      type CoinGroup = { [txid: string]: { total: number; wallets: Array<ObjectID> } };
      const groupedMints = params.mintOps.reduce<CoinGroup>((agg, coinOp) => {
        const mintTxid = coinOp.updateOne.filter.mintTxid;
        const coin = coinOp.updateOne.update.$set;
        const { value, wallets } = coin;
        if (!agg[mintTxid]) {
          agg[mintTxid] = {
            total: value,
            wallets: wallets || []
          };
        } else {
          agg[mintTxid].total += value;
          agg[mintTxid].wallets.push(...wallets);
        }
        return agg;
      }, {});

      const groupedSpends = spent.reduce<CoinGroup>((agg, coin) => {
        if (!agg[coin.spentTxid]) {
          agg[coin.spentTxid] = {
            total: coin.value,
            wallets: coin.wallets || []
          };
        } else {
          agg[coin.spentTxid].total += coin.value;
          agg[coin.spentTxid].wallets.push(...coin.wallets);
        }
        return agg;
      }, {});

      let txOps = params.txs.map(tx => {
        const txid = tx._hash!;
        const minted = groupedMints[txid] || {};
        const spent = groupedSpends[txid] || {};
        const mintedWallets = minted.wallets || [];
        const spentWallets = spent.wallets || [];
        const txWallets = mintedWallets.concat(spentWallets);
        const wallets = lodash.uniqBy(txWallets, wallet => wallet.toHexString());
        let fee = 0;
        if (groupedMints[txid] && groupedSpends[txid]) {
          // TODO: Fee is negative for mempool txs
          fee = groupedSpends[txid].total - groupedMints[txid].total;
          if (fee < 0) {
            console.error(txid, groupedSpends[txid], groupedMints[txid]);
          }
        }

        return {
          updateOne: {
            filter: { txid, chain, network },
            update: {
              $set: {
                chain,
                network,
                blockHeight: height,
                blockHash,
                blockTime,
                blockTimeNormalized,
                coinbase: tx.isCoinbase(),
                fee,
                size: tx.toBuffer().length,
                locktime: tx.nLockTime,
                inputCount: tx.inputs.length,
                outputCount: tx.outputs.length,
                value: tx.outputAmount,
                wallets
              }
            },
            upsert: true,
            forceServerObjectId: true
          }
        };
      });
      return txOps;
    }
  }

  //TODO high: highest read this
  async getMintOps(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
    mintOps?: Array<any>;
  }) {
    let { chain, height, network, parentChain, forkHeight, initialSyncComplete } = params;
    let mintOps = new Array<any>();
    let parentChainCoinsMap = new Map();

    //calling from block.ts & has the parent chain defined & current height has not reached the fork height
    //in other words, if we are in a range where we can be "lazy"
    //this is a special set of criteria (parent-fork-height) that we will see again and again in this code

    //TODO high: to read and understand later
    if (parentChain && forkHeight && height < forkHeight) {
      let parentChainCoins = await CoinModel.collection
        .find({
          chain: parentChain,
          network,
          mintHeight: height,
          $or: [{ spentHeight: { $lt: SpentHeightIndicators.minimum } }, { spentHeight: { $gte: forkHeight } }]
        })
        .project({ mintTxid: 1, mintIndex: 1 })
        .toArray();
      for (const parentChainCoin of parentChainCoins) {
        parentChainCoinsMap.set(`${parentChainCoin.mintTxid}:${parentChainCoin.mintIndex}`, true);
      }
    }
    //we loop through all tx
    for (let tx of params.txs) {
      tx._hash = tx.hash;
      let isCoinbase = tx.isCoinbase();
      logger.debug(`YCM models/transaction.ts processing outputs of tx ${util.inspect(tx)}`);

      //for each tx, we loop through all outputs
      for (let [index, output] of tx.outputs.entries()) {
        //if in 'lazy zone', skip
        if (
          parentChain &&
          forkHeight &&
          height < forkHeight &&
          (!parentChainCoinsMap.size || !parentChainCoinsMap.get(`${tx._hash}:${index}`))
        ) {
          continue;
        }
        let address = '';
        //TODO high: at which point, is the output get translated from binaries to readable script?
        //sample inspection of an output: <Output (13994792 sats) <Script: OP_HASH160 20 0xc69535f5529fa12ccd5626e38de1e02659bcc146 OP_EQUAL>>
        if (output.script) {
          //bitcore-lib/bitcore-lib.js Script.prototype.toAddress = function(network) {...}
          address = output.script.toAddress(network).toString(true);
          if (address === 'false' && output.script.classify() === 'Pay to public key') {
            let hash = Chain[chain].lib.crypto.Hash.sha256ripemd160(output.script.chunks[0].buf);
            address = Chain[chain].lib.Address(hash, network).toString(true);
          }
        }

        //updateOne( filter:{}, update:{}, options:{})
        //seems we write it in this way updateOne( filter:{}, update:{}, option1:xxx, option2:xxx)
        //https://docs.mongodb.com/manual/reference/method/db.collection.updateOne/index.html
        //update has three update operators: $set, $unset, or $rename
        //https://docs.mongodb.com/manual/reference/operator/update/set/#up._S_set

        //mintOps is just an array, there will be some other functions to actually perform the update
        mintOps.push({
          updateOne: {
            filter: {
              mintTxid: tx._hash,
              mintIndex: index,
              spentHeight: { $lt: SpentHeightIndicators.minimum },
              chain,
              network
            },
            update: {
              $set: {
                chain,
                network,
                address,
                mintHeight: height,
                coinbase: isCoinbase,
                value: output.satoshis,
                script: output.script && output.script.toBuffer(),
                spentHeight: SpentHeightIndicators.unspent,
                wallets: []
              }
            },
            upsert: true,
            forceServerObjectId: true
          }
        });
      }
    }

    //for an iteratable, map() syntax is iteratable.map( singleElement => { ... return transformedElement} )
    //for an array, map() syntax is array.map( (value,index,array) => { ... return transformedValue} )
    //for filter, instead of return a value or element, return a boolean true/false
    if (initialSyncComplete) {
      //create mintOp -> its addresss mapping
      let mintOpsAddresses = {};
      for (const mintOp of mintOps) {
        mintOpsAddresses[mintOp.updateOne.update.$set.address] = true;
      }
      mintOpsAddresses = Object.keys(mintOpsAddresses);
      let wallets = await WalletAddressModel.collection
        .find({ address: { $in: mintOpsAddresses }, chain, network }, { batchSize: 100 })
        .toArray();
      if (wallets.length) {
        //TODO low: how to add an entry to WalletAddress, i want to try both mintOp and SpendOps out
        //for each wallet, check if (wallet.address===mintOp.updateOne.update.$set.address), keep only those whose func return true
        //wallet.wallet seems to refer to IWalletAddress.wallet: ObjectID, in models/walletAddress.ts
        //my understanding is, if the addresss is found in WalletAddress collection, then its wallet:ObjectID is set to the mintOp document
        mintOps = mintOps.map(mintOp => {
          let transformedWallets = wallets
            .filter(wallet => wallet.address === mintOp.updateOne.update.$set.address)
            .map(wallet => wallet.wallet);
          mintOp.updateOne.update.$set.wallets = transformedWallets;
          return mintOp;
        });
      }
    }

    return mintOps;
  }

  //TODO high: read this
  getSpendOps(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    parentChain?: string;
    forkHeight?: number;
    chain: string;
    network: string;
    mintOps?: Array<any>;
    [rest: string]: any;
  }): Array<any> {
    let { chain, network, height, parentChain, forkHeight } = params;
    let spendOps: any[] = [];
    //if in 'lazy zone', return empty array
    if (parentChain && forkHeight && height < forkHeight) {
      return spendOps;
    }
    let mintMap = {};
    for (let mintOp of params.mintOps || []) {
      //TODO high: ???
      //so that what is inside this mintMap[]?
      mintMap[mintOp.updateOne.filter.mintTxid] = mintMap[mintOp.updateOne.filter.mintIndex] || {};
      mintMap[mintOp.updateOne.filter.mintTxid][mintOp.updateOne.filter.mintIndex] = mintOp;
    }
    for (let tx of params.txs) {
      if (tx.isCoinbase()) {
        continue;
      }
      for (let input of tx.inputs) {
        let inputObj = input.toObject();
        let sameBlockSpend = mintMap[inputObj.prevTxId] && mintMap[inputObj.prevTxId][inputObj.outputIndex];
        if (sameBlockSpend) {
          sameBlockSpend.updateOne.update.$set.spentHeight = height;
          sameBlockSpend.updateOne.update.$set.spentTxid = tx._hash;
          continue;
        }
        const updateQuery: any = {
          updateOne: {
            filter: {
              mintTxid: inputObj.prevTxId,
              mintIndex: inputObj.outputIndex,
              spentHeight: { $lt: SpentHeightIndicators.minimum },
              chain,
              network
            },
            update: { $set: { spentTxid: tx._hash, spentHeight: height } }
          }
        };
        spendOps.push(updateQuery);
      }
    }
    return spendOps;
  }

  async pruneMempool(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    parentChain?: string;
    forkHeight?: number;
    chain: string;
    network: string;
    mintOps: Array<any>;
    spendOps: Array<any>;
    initialSyncComplete: boolean;
    [rest: string]: any;
  }) {
    const { chain, network, spendOps, initialSyncComplete } = params;
    if (!initialSyncComplete || !spendOps.length) {
      return;
    }
    let prunedTxs = {};
    for (const spendOp of spendOps) {
      let coin = await CoinModel.collection.findOne(
        {
          chain,
          network,
          spentHeight: SpentHeightIndicators.pending,
          mintTxid: spendOp.updateOne.filter.mintTxid,
          mintIndex: spendOp.updateOne.filter.mintIndex,
          spentTxid: { $ne: spendOp.updateOne.update.$set.spentTxid }
        },
        { projection: { spentTxid: 1 } }
      );
      if (coin) {
        prunedTxs[coin.spentTxid] = true;
      }
    }
    if (Object.keys(prunedTxs).length) {
      prunedTxs = Object.keys(prunedTxs);
      await Promise.all([
        this.collection.update(
          { txid: { $in: prunedTxs } },
          { $set: { blockHeight: SpentHeightIndicators.conflicting } },
          { w: 0, j: false, multi: true }
        ),
        CoinModel.collection.update(
          { mintTxid: { $in: prunedTxs } },
          { $set: { mintHeight: SpentHeightIndicators.conflicting } },
          { w: 0, j: false, multi: true }
        )
      ]);
    }
    return;
  }

  getTransactions(params: { query: any; options: StreamingFindOptions<ITransaction> }) {
    let originalQuery = params.query;
    const { query, options } = Storage.getFindOptions(this, params.options);
    const finalQuery = Object.assign({}, originalQuery, query);
    return this.collection.find(finalQuery, options).addCursorFlag('noCursorTimeout', true);
  }

  _apiTransform(tx: Partial<MongoBound<ITransaction>>, options: TransformOptions): TransactionJSON | string {
    const transaction: TransactionJSON = {
      _id: tx._id ? tx._id.toString() : '',
      txid: tx.txid || '',
      network: tx.network || '',
      chain: tx.chain || '',
      blockHeight: tx.blockHeight || -1,
      blockHash: tx.blockHash || '',
      blockTime: tx.blockTime ? tx.blockTime.toISOString() : '',
      blockTimeNormalized: tx.blockTimeNormalized ? tx.blockTimeNormalized.toISOString() : '',
      coinbase: tx.coinbase || false,
      locktime: tx.locktime || -1,
      inputCount: tx.inputCount || -1,
      outputCount: tx.outputCount || -1,
      size: tx.size || -1,
      fee: tx.fee || -1,
      value: tx.value || -1
    };
    if (options && options.object) {
      return transaction;
    }
    return JSON.stringify(transaction);
  }
}
export let TransactionModel = new Transaction();
