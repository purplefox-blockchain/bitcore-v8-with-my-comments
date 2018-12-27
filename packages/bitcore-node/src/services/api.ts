import * as http from 'http';
import SocketIO = require('socket.io');
import mongoose from 'mongoose';
import app from '../routes';
import logger from '../logger';
import config from '../config';
import { LoggifyClass } from '../decorators/Loggify';
import { Storage } from './storage';
import { Socket } from './socket';

@LoggifyClass
export class ApiService {
  port: number;
  timeout: number;

  constructor(options) {
    const { port, timeout } = options;

    this.port = port || 3000;
    this.timeout = timeout || 600000;
  }

  async start() {
    logger.info(`YCM TRACKER === services/api.ts start()`);

    //there is no other mongoose referenced in any other place in bitcore-node, i dont think it is used anywhere.
    //by adding some tracking code to socket.ts (whose func are called every x seconds), i didn't find this mongoose.connection.readyState will ever turn to 1 (connected)
    //https://medium.freecodecamp.org/introduction-to-mongoose-for-mongodb-d2a7aa593c57
    //mongoose follows a singleton model. by requiring mongoose, it returns a singleton obj and caches it
    //a mongoose model is a wrapper on the mongoose schema. a mongoose schema defines the structure of the document, default values, validators, etc., 
    //whereas a mongoose model provides an interface to the database for creating, querying, updating, deleting records, etc.

    if (mongoose.connection.readyState !== 1) {
      logger.info("YCM TRACKER === services/api.ts start() - starting storage");
      await Storage.start({});
    } else {
      //never going to happen
    }

    //the high level view is
    //- app         is an express object, which has in-built routing capability, see ../routes packages
    //- httpServer  is an server object, which listens on a given port and delegate incoming requests to the express app
    //- io          is a socket.io object, which wraps around httpServer and provides additonal websocket capability 
    //- Socket      is a bitcore object, which wraps around io, and pass/publish bitcore-related events through the underlying communication framework socket.io
    
    //More about socket.io
    //Socket.IO is a library that enables real-time, bidirectional and event-based communication between the browser and the server.
    //It consists of a node.js server and a javascript client library for the browser
    //Note that Socket.IO is NOT a WebSocket implementation. Although Socket.IO indeed uses WebSocket as a transport when possible, it adds some metadata to each packet. 
    //That is why a WebSocket client will not be able to successfully connect to a Socket.IO server, and a Socket.IO client will not be able to connect to a WebSocket server either. 

    const httpServer = new http.Server(app);
    const io = SocketIO(httpServer);
    httpServer.listen(this.port, () => {
      logger.info("YCM TRACKER === services/api.ts start() - http server is listening");
      logger.info(`API server started on port ${this.port}`);
      Socket.setServer(io);
    });
    httpServer.timeout = this.timeout;
  }

  stop() {}
}

// TOOO: choose a place in the config for the API timeout and include it here
export const Api = new ApiService({
  port: config.port
});
