'use strict';

var bitcore = require('bitcore-lib');
var Inventory = require('../inventory');

function builder(options) {
  /* jshint maxstatements: 20 */
  /* jshint maxcomplexity: 10 */

  if (!options) {
    options = {};
  }

  if (!options.network) {
    options.network = bitcore.Networks.defaultNetwork;
  }

  options.Block = options.Block || bitcore.Block;
  options.BlockHeader = options.BlockHeader || bitcore.BlockHeader;
  options.Transaction = options.Transaction || bitcore.Transaction;
  options.MerkleBlock = options.MerkleBlock || bitcore.MerkleBlock;
  options.protocolVersion = options.protocolVersion || 70001;

  //we often can see in bitcore-node/src/services/p2p.ts 
  //we have code like this.messages.GetHeaders(...) 
  //the GetHeaders() is actually dynamically added by this builder
  var exported = {
    constructors: {
      Block: options.Block,
      BlockHeader: options.BlockHeader,
      Transaction: options.Transaction,
      MerkleBlock: options.MerkleBlock
    },
    defaults: {
      protocolVersion: options.protocolVersion,
      network: options.network
    },
    inventoryCommands: [
      'getdata',
      'inv',
      'notfound'
    ],
    commandsMap: {
      version: 'Version',
      verack: 'VerAck',
      ping: 'Ping',
      pong: 'Pong',
      block: 'Block',
      tx: 'Transaction',
      getdata: 'GetData',
      headers: 'Headers',
      notfound: 'NotFound',
      inv: 'Inventory',
      addr: 'Addresses',
      alert: 'Alert',
      reject: 'Reject',
      merkleblock: 'MerkleBlock',
      filterload: 'FilterLoad',
      filteradd: 'FilterAdd',
      filterclear: 'FilterClear',
      getblocks: 'GetBlocks',
      getheaders: 'GetHeaders',
      mempool: 'MemPool',
      getaddr: 'GetAddr'
    },
    commands: {}
  };

  //define 'add' function here 
  //this internal function provides a way to return a new Command obj for calls like builder.commands[GetBlocks]
  exported.add = function(key, Command) {
    exported.commands[key] = function(obj) {
      return new Command(obj, options);
    };

    exported.commands[key]._constructor = Command;

    //we kind of attach a function to commands[someCommand] object
    exported.commands[key].fromBuffer = function(buffer) {
      //create a new message using constructor
      var message = exported.commands[key]();
      //call individual message's setPayload()
      console.debug("YCM TRACKER === bitcore-p2p/lib/messages/builder.js xxxMessage.fromBuffer() - delegating to xxxMessage.setPayload()...");
      message.setPayload(buffer);
      return message;
    };
  };

  //this iterates through all keys in commandsMap and call the add() function defined above
  Object.keys(exported.commandsMap).forEach(function(key) {
    exported.add(key, require('./commands/' + key));
  });

  //TODO low: what is this inventoryCommands?
  exported.inventoryCommands.forEach(function(command) {

    // add forTransaction methods
    exported.commands[command].forTransaction = function forTransaction(hash) {
      return new exported.commands[command]([Inventory.forTransaction(hash)]);
    };

    // add forBlock methods
    exported.commands[command].forBlock = function forBlock(hash) {
      return new exported.commands[command]([Inventory.forBlock(hash)]);
    };

    // add forFilteredBlock methods
    exported.commands[command].forFilteredBlock = function forFilteredBlock(hash) {
      return new exported.commands[command]([Inventory.forFilteredBlock(hash)]);
    };

  });

  return exported;

}

module.exports = builder;
