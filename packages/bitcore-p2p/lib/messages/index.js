 'use strict';

var bitcore = require('bitcore-lib');
var BufferUtil = bitcore.util.buffer;
var Hash = bitcore.crypto.Hash;
var $ = bitcore.util.preconditions;

/**
 * A factory to build Bitcoin protocol messages.
 * @param {Object=} options
 * @param {Network=} options.network
 * @param {Function=} options.Block - A block constructor
 * @param {Function=} options.BlockHeader - A block header constructor
 * @param {Function=} options.MerkleBlock - A merkle block constructor
 * @param {Function=} options.Transaction - A transaction constructor
 * @constructor
 */
function Messages(options) {
  //Messages is the bitcore-p2p/lib/messages folder
  //Messages.builder refers to bitcore-p2p/lib/messages/builder.js file
  //on runtime we pass {network: livenet/testnet}
  //in the end, we get a builder which is capable of returning a Command object upon request builder.commands[GetBlocks]
  this.builder = Messages.builder(options);

  // map message constructors by name
  //we map all commands supported by this.builder and expose them at this layer, so that builder will be transparent to external clients
  //in p2p.ts, we can see some code like this
  //- this.pool.sendMessage(this.messages.GetHeaders({starts: candidateHashes})
  //- this.pool.sendMessage(this.messages.GetData.forBlock(hash));
  //these code use dot format to obtain the command object
  for(var key in this.builder.commandsMap) {
    var name = this.builder.commandsMap[key];
    //besides messages[CommandName], caller can also use the dot format, messages.CommandName
    this[name] = this.builder.commands[key];
  }

  if (!options) {
    options = {};
  }
  this.network = options.network || bitcore.Networks.defaultNetwork;
}

Messages.MINIMUM_LENGTH = 20;
Messages.PAYLOAD_START = 16;
Messages.Message = require('./message');
Messages.builder = require('./builder');

//this is a very important function to bridge the binary raw data and our internal message data structure
//called by peer.js to parse EVERY SINGLE raw message
//https://bitcoin.org/en/developer-reference#message-headers
//part    bytes   content
//A       0,4     network magic number
//B       4,16    command name
//C       16,20   payload size
//D       20,24   checksum
//E       24+++   real payload data (whose size is specfied above)
/**
 * @param {Buffers} dataBuffer
 */
Messages.prototype.parseBuffer = function(dataBuffer) {

  //console.info(`YCM TRACKER === bitcore-p2p/lib/messages/index.js parseBuffer() 1`);
  
  /* jshint maxstatements: 18 */
  if (dataBuffer.length < Messages.MINIMUM_LENGTH) {
    //console.info(`YCM TRACKER === bitcore-p2p/lib/messages/index.js parseBuffer() 9 - no more data in buffer ${dataBuffer.length}`);
    return;
  }

  //a higher level tracking message
  console.info(`YCM TRACKER === bitcore-p2p/lib/messages/index.js parseBuffer()`);

  //part A
  //every network, livenet or testnet of btc/bch has its own network magic number
  //we need to continue reading the buffer until we find the magic number of our network
  //by scanning through the buffer, if we reach the end of the buffer, we skil the entire parseBuffer() for this round (of course peer.js will call us again)
  //if we do find the magic number, we continue...
  
  //console.debug(`YCM TRACKER === bitcore-p2p/lib/messages/index.js parseBuffer() 2 - check network magic number`);
  // Search the next magic number
  if (!this._discardUntilNextMessage(dataBuffer)) {
    return;
  }

  //part C
  //bitwise shift operator goes like:
  //9 (base 10): 00000000000000000000000000001001 (base 2)
  //9 << 2 (base 10): 00000000000000000000000000100100 (base 2) = 36 (base 10)
  //so a number a << b give us a*(2^b)
  //we read 4 bytes from dataBuffer, i.e. dataBuffer[16] dataBuffer[17] dataBuffer[18] dataBuffer[19] 
  //the raw data 16161616171717171818181819191919 are interpreted as => 19191919181818181717171716161616
  var payloadLen = (dataBuffer.get(Messages.PAYLOAD_START)) +
    (dataBuffer.get(Messages.PAYLOAD_START + 1) << 8) +
    (dataBuffer.get(Messages.PAYLOAD_START + 2) << 16) +
    (dataBuffer.get(Messages.PAYLOAD_START + 3) << 24);

  var messageLength = 24 + payloadLen;
  if (dataBuffer.length < messageLength) {
    return;
  }

  //part B + D
  var command = dataBuffer.slice(4, 16).toString('ascii').replace(/\0+$/, '');
  var payload = dataBuffer.slice(24, messageLength);
  var checksum = dataBuffer.slice(20, 24);

  //console.debug(`YCM TRACKER === bitcore-p2p/lib/messages/index.js parseBuffer() 3 - check checksum`);
  var checksumConfirm = Hash.sha256sha256(payload).slice(0, 4);
  //if checksum failed, we will not return any parsed message
  if (!BufferUtil.equals(checksumConfirm, checksum)) {
    dataBuffer.skip(messageLength);
    return;
  }
  
  dataBuffer.skip(messageLength);

  //part E
  //we try to _buildFromBuffer given the real payload, the resulting message is returned to our caller (peer.js)
  //console.debug(`YCM TRACKER === bitcore-p2p/lib/messages/index.js parseBuffer() - delegating to _buildFromBuffer() to parse actual message payload`);
  return this._buildFromBuffer(command, payload);
};

Messages.prototype._discardUntilNextMessage = function(dataBuffer) {
  $.checkArgument(dataBuffer);
  $.checkState(this.network, 'network must be set');
  var i = 0;
  for (;;) {
    // check if it's the beginning of a new message
    var packageNumber = dataBuffer.slice(0, 4).toString('hex');
    if (packageNumber === this.network.networkMagic.toString('hex')) {
      dataBuffer.skip(i);
      return true;
    }

    // did we reach the end of the buffer?
    if (i > (dataBuffer.length - 4)) {
      dataBuffer.skip(i);
      return false;
    }

    i++; // continue scanning
  }
};

//given the real payload for the command, we let the command to parse the data
//by calling fromBuffer() of the respective command
Messages.prototype._buildFromBuffer = function(command, payload) {
  if (!this.builder.commands[command]) {
    throw new Error('Unsupported message command: ' + command);
  }
  //this fromBuffer() is defined in bitcore-p2p/lib/messages/builder.js line
  //exported.commands[key].fromBuffer = function(buffer) {...}
  //essentially calling exported.commands[key].setPayload(buffer)
  console.debug(`YCM TRACKER === bitcore-p2p/lib/messages/index.js _buildFromBuffer() - delegating to xxxCommmand.fromBuffer (defined in builder.js)`);
  return this.builder.commands[command].fromBuffer(payload);
};

Messages.prototype.add = function(key, name, Command) {
  this.builder.add(key, Command);
  this[name] = this.builder.commands[key];
};

module.exports = Messages;
