'use strict';

var Buffers = require('./buffers');
var EventEmitter = require('events').EventEmitter;
var Net = require('net');
var Socks5Client = require('socks5-client');
var bitcore = require('bitcore-lib');
var bcoin = require('bcoin');
var Networks = bitcore.Networks;
var Messages = require('./messages');
var $ = bitcore.util.preconditions;
var util = require('util');

/**
 * The Peer constructor will create an instance of Peer to send and receive messages
 * using the standard Bitcoin protocol. A Peer instance represents one connection
 * on the Bitcoin network. To create a new peer connection provide the host and port
 * options and then invoke the connect method. Additionally, a newly connected socket
 * can be provided instead of host and port.
 *
 * @example
 * ```javascript
 *
 * var peer = new Peer({host: '127.0.0.1'}).setProxy('127.0.0.1', 9050);
 * peer.on('tx', function(tx) {
 *  console.log('New transaction: ', tx.id);
 * });
 * peer.connect();
 * ```
 *
 * @param {Object} options
 * @param {String} options.host - IP address of the remote host
 * @param {Number} options.port - Port number of the remote host
 * @param {Network} options.network - The network configuration
 * @param {Boolean=} options.relay - An option to disable automatic inventory relaying from the remote peer
 * @param {Socket=} options.socket - An existing connected socket

 * @returns {Peer} A new instance of Peer.
 * @constructor
 */
function Peer(options) {
  /* jshint maxstatements: 26 */
  /* jshint maxcomplexity: 8 */

  if (!(this instanceof Peer)) {
    return new Peer(options);
  }

  if (options.socket) {
    this.socket = options.socket;
    this.host = this.socket.remoteAddress;
    this.port = this.socket.remotePort;
    this.status = Peer.STATUS.CONNECTED;
    this._addSocketEventHandlers();
  } else {
    this.host = options.host || 'localhost';
    this.status = Peer.STATUS.DISCONNECTED;
    this.port = options.port;
  }

  this.network = Networks.get(options.network) || Networks.defaultNetwork;

  if (!this.port) {
    this.port = this.network.port;
  }

  //if we trace the code all the way back, this messages is originally set in p2p.ts as
  //  this.messages = new this.bitcoreP2p.Messages(...)
  //it is basically a message builder which is capable of producing new messages whenever needed
  //its type is bitcore-p2p/lib/messages/index.js or all .js files under messages package
  this.messages = options.messages || new Messages({
    network: this.network,
    Block: bcoin.block,
    Transaction: bcoin.tx
  });

  this.dataBuffer = new Buffers();

  this.version = 0;
  this.bestHeight = 0;
  this.subversion = null;
  this.relay = options.relay === false ? false : true;

  this.versionSent = false;

  // set message handlers
  var self = this;
  this.on('verack', function() {
    self.status = Peer.STATUS.READY;
    self.emit('ready');
  });

  this.on('version', function(message) {
    self.version = message.version;
    self.subversion = message.subversion;
    self.bestHeight = message.startHeight;

    var verackResponse = self.messages.VerAck();
    self.sendMessage(verackResponse);

    if(!self.versionSent) {
      self._sendVersion();
    }
  });

  this.on('ping', function(message) {
    self._sendPong(message.nonce);
  });

  return this;

}
util.inherits(Peer, EventEmitter);

Peer.MAX_RECEIVE_BUFFER = 10000000;
Peer.STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  READY: 'ready'
};

/**
 * Set a socks5 proxy for the connection. Enables the use of the TOR network.
 * @param {String} host - IP address of the proxy
 * @param {Number} port - Port number of the proxy
 * @returns {Peer} The same Peer instance.
 */
Peer.prototype.setProxy = function(host, port) {
  $.checkState(this.status === Peer.STATUS.DISCONNECTED);

  this.proxy = {
    host: host,
    port: port
  };
  return this;
};

/**
 * Init the connection with the remote peer.
 * @returns {Peer} The same peer instance.
 */
Peer.prototype.connect = function() {
  this.socket = this._getSocket();
  this.status = Peer.STATUS.CONNECTING;

  var self = this;
  this.socket.on('connect', function(ev) {
    self.status = Peer.STATUS.CONNECTED;
    self.emit('connect');
    self._sendVersion();
  });

  this._addSocketEventHandlers();
  this.socket.connect(this.port, this.host);
  return this;
};

Peer.prototype._addSocketEventHandlers = function() {
  var self = this;

  this.socket.on('error', self._onError.bind(this));
  this.socket.on('end', self.disconnect.bind(this));

  this.socket.on('data', function(data) {
    console.info(`YCM TRACKER === bitcore-p2p/peer.js =====================`);
    console.info(`YCM TRACKER === bitcore-p2p/peer.js socket on raw data...`);
    console.info(`YCM TRACKER === bitcore-p2p/peer.js =====================`);
    console.info(`YCM TRACKER === bitcore-p2p/peer.js delegating to _readMessage()`);
    //obviously this is unparsed non-readable raw data
    //console.debug(`YCM bitcore-p2p/peer.js data contents are ${data}`);
    self.dataBuffer.push(data);

    if (self.dataBuffer.length > Peer.MAX_RECEIVE_BUFFER) {
      // TODO: handle this case better
      return self.disconnect();
    }
    self._readMessage();
  });
};

Peer.prototype._onError = function(e) {
  this.emit('error', e);
  if (this.status !== Peer.STATUS.DISCONNECTED) {
    this.disconnect();
  }
};

/**
 * Disconnects the remote connection.
 * @returns {Peer} The same peer instance.
 */
Peer.prototype.disconnect = function() {
  this.status = Peer.STATUS.DISCONNECTED;
  this.socket.destroy();
  this.emit('disconnect');
  return this;
};

/**
 * Send a Message to the remote peer.
 * @param {Message} message - A message instance
 */
Peer.prototype.sendMessage = function(message) {
  this.socket.write(message.toBuffer());
};

/**
 * Internal function that sends VERSION message to the remote peer.
 */
Peer.prototype._sendVersion = function() {
  // todo: include sending local ip address
  var message = this.messages.Version({relay: this.relay});
  this.versionSent = true;
  this.sendMessage(message);
};

/**
 * Send a PONG message to the remote peer.
 */
Peer.prototype._sendPong = function(nonce) {
  var message = this.messages.Pong(nonce);
  this.sendMessage(message);
};

//upon first starting the program, we will receive the following events/messages
//- version ()
//- verack ()
//- alert ()
//- ping (other peers to verify connection between us is still valid)
//- getheaders （other peers want to know if they have the latest blocks)
//- headers (other peers returns block headers in response to our getheaders message, it means they have some block that we dont know)
//- block (if there is new block)
//... after fully sync
//- inv
//- tx
/**
 * Internal function that tries to read a message from the data buffer
 */
Peer.prototype._readMessage = function() {
  console.debug(`YCM TRACKER === bitcore-p2p/peer.js _readMessage() 1 - delgeting the parsing to bitcore-p2p/lib/messages/index.js parseBuffer()`);
  //the end result of this parseBuffer() is, the returned message is a parsed message e.g. InvMessage, TransactionMessage
  //there are two scenario that worth mentioning
  //1. when the buffer is incomplete, this.messages.parseBuffer() will simply return nothing
  //2. when the buffer is empty, the parseBuffer() will also return nothing
  //since we are recursively calling _readMessage(), the very last call will always be scenario 2, if (message) will be false
  var message = this.messages.parseBuffer(this.dataBuffer);
  //
  if (message) {
    console.debug(`YCM TRACKER === bitcore-p2p/peer.js _readMessage() 2 - after parsing, emit message *** ${message.command} ***`);
    if (message.command!=='XXX') {
      let clonedMessage = Object.assign({}, message);
      delete clonedMessage.network;
      //my understanding: level 0 means only those info implemented in the custom inspect() will get printed
      console.debug(`YCM TRACKER === bitcore-p2p/peer.js _readMessage() 2 - message content is ${util.inspect(clonedMessage,false,0,false)}`);
    }
    console.debug(`YCM TRACKER === bitcore-p2p/peer.js _readMessage() 4 - control flow now goes back to bitcore-node soon...`);
    console.debug(`YCM TRACKER === bitcore-p2p/peer.js _readMessage() ======================================================`);
    this.emit(message.command, message);
    //TODO low: calling self? looks confusing to me, to find out more...
    //or can i say this is to keep parsing buffer until message is completed?
    //we will recall the func itself, until the message.parseBuffer() finds it out there is no more data to parse
    this._readMessage();
  } else {
    console.debug(`YCM TRACKER === bitcore-p2p/peer.js _readMessage() 9 - empty dataBuffer`);
  }
};

/**
 * Internal function that creates a socket using a proxy if necessary.
 * @returns {Socket} A Socket instance not yet connected.
 */
Peer.prototype._getSocket = function() {
  if (this.proxy) {
    return new Socks5Client(this.proxy.host, this.proxy.port);
  }

  return new Net.Socket();
};

module.exports = Peer;
