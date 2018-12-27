import { P2pService } from './services/p2p';
import { Storage } from './services/storage';
import { Worker } from './services/worker';
import { Api } from './services/api';
import cluster = require('cluster');
import parseArgv from './utils/parseArgv';
let args = parseArgv([], ['DEBUG']);

import logger from './logger';

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection at:', error.stack || error)
});

const startServices = async () => {
  await Storage.start({});
  await Worker.start();
  P2pService.startConfiguredChains();
};

const runMaster = async() => {
  logger.info('YCM TRACKER === server.ts runMaster()');
  logger.debug('YCM server.ts args.debug = ',args.DEBUG?'true':'false');
  await startServices();
  // start the API on master if we are in debug
  if(args.DEBUG){
    Api.start();
  }
};

const runWorker = async() => {
  logger.info('YCM TRACKER === server.ts runWorker()');
  // don't run any workers when in debug mode
  if(!args.DEBUG){
    // Api will automatically start storage if it isn't already running
    Api.start();
  }
}

const start = async() => {
  if(cluster.isMaster){
    await runMaster();
  } else{
    await runWorker();
  }
}

start();
