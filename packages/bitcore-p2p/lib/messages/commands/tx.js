'use strict';

var Message = require('../message');
var inherits = require('util').inherits;
var bitcore = require('bitcore-lib');
var bcoin = require('bcoin');
var $ = bitcore.util.preconditions;
var _ = bitcore.deps._;

var util = require('util');

/**
 * @param {Transaction=} arg - An instance of Transaction
 * @param {Object} options
 * @extends Message
 * @constructor
 */
function TransactionMessage(arg, options) {
  //console.debug(`YCM TRACKER === bitcore-p2p/lib/messages/commands/tx.js TransactionMessage constructor()`);
  Message.call(this, options);
  this.command = 'tx';
  this.Transaction = options.Transaction;
  $.checkArgument(
    _.isUndefined(arg) || arg instanceof this.Transaction,
    'An instance of Transaction or undefined is expected'
  );
  //note that we have this.transaction v.s. this.Transaction
  //it looks weird. anyway this.Transaction seems to be a func/constructor
  //ultimately we get an instance of Transaction, which is this.transaction
  this.transaction = arg;
  if (!this.transaction) {
    this.transaction = new this.Transaction();
  }
}
inherits(TransactionMessage, Message);

TransactionMessage.prototype.setPayload = function(payload) {
  //console.debug(`YCM TRACKER === bitcore-p2p/lib/messages/commands/tx.js setPayload()`);
  //so far what i see is, the payload is coming 'fromBuffer'
  if (this.Transaction.prototype.fromRaw) {
    this.transaction = bcoin.tx.fromRaw(payload);
  } else if (this.Transaction.prototype.fromBuffer) {
    //calling Transaction's fromBuffer() to parse the real payload
    //for btc, it will jump to bitcore-lib/lib/transaction/transaction.js
    this.transaction = new this.Transaction().fromBuffer(payload);
  } else {
    this.transaction = this.Transaction.fromBuffer(payload);
  }
};

TransactionMessage.prototype.getPayload = function() {
  //console.debug(`YCM TRACKER === bitcore-p2p/lib/messages/commands/tx.js getPayload()`);
  if (this.Transaction.prototype.toRaw) {
    return this.transaction.toRaw();
  }
  return this.transaction.toBuffer();
};

//YCM added for inspection
TransactionMessage.prototype.inspect = function() {
  return '\n<<<TransactionMessage: '
          + ' \ncommand: ' + this.command 
          + ' \ntransaction: ' + util.inspect(this.transaction)
          + ' >>> ';
};

module.exports = TransactionMessage;
