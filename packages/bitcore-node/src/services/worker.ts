import { CallbackType } from '../types/Callback';
import { WorkerType } from '../types/Worker';
import { LoggifyClass } from '../decorators/Loggify';
import logger from '../logger';
import config from '../config';
import parseArgv from '../utils/parseArgv';

const cluster = require('cluster');
const { EventEmitter } = require('events');
let args = parseArgv([], ['DEBUG']);

@LoggifyClass
export class WorkerService extends EventEmitter {
  workers = new Array<{
    worker: WorkerType;
    active: boolean;
    started: Promise<any>;
  }>();

  //any process that created via cluster.fork() will have cluster.isMaster() as false
  async start() {
    if (cluster.isMaster) {
      logger.info(`YCM TRACKER === services/worker.ts start() - THIS IS A MASTER NODE`);
      logger.info(`Master ${process.pid} is running`);
      cluster.on('exit', (worker: WorkerType) => {
        logger.error(`worker ${worker.process.pid} died`);
      });
      if (!args.DEBUG) {
        logger.info(`YCM service/worker.ts the master node starts forking workers...`);
        for (let worker = 0; worker < config.numWorkers; worker++) {
          logger.info(`YCM service/worker.ts forking worker #${worker}...`);
          //IMPORTANT FORK: we use node.js' cluster module to perform the process forking
          //newWorker is the newly created worker by this fork()
          //seems the worker will also start from server.ts from which it then turn to a different direction: api.ts
          let newWorker = cluster.fork();
          //TODO lower: find out what is this, and when such message event gets fired. seems this event never get fired
          newWorker.on('message', (msg: any) => {
            this.emit(msg.id, msg);
          });
          //more on grammer and syntax:
          //when the worker is listening, we mark it as resolved
          //however in this particular promise, we are not interested in marking any as reject,
          //that is why we only have resolve=>{...} not (resolve,reject)=>{...}
          let started = new Promise(resolve => {
            newWorker.on('listening', () => {
              resolve();
            });
          });
          //register this new worker to the worker array
          this.workers.push({ worker: newWorker, active: false, started });
        }
      }
      const startedPromises = this.workers.map(worker => worker.started);
      //Promise.all(iterable) method returns a single Promise that resolves when all of the promises
      //have resolved. It rejects with the reason of the first promise that rejects.
      return Promise.all(startedPromises);
    } else {
      //seems this branch will never get called, the worker goes to api.ts directly from server.ts
      logger.info(`Worker ${process.pid} started`);
      return;
    }
  }

  stop() {}

  //TODO lower: who will call this func? seems no one. the master-worker communication need more detailed look
  sendTask(task: any, argument: any, done: CallbackType) {
    //the first worker is the object we will send the task to
    //shift() remove the this worker and later we push it back to the end of the array
    var worker = this.workers.shift();
    if (worker) {
      this.workers.push(worker);
      var id = (Date.now() * Math.random()).toString();
      //EventEmitter.once() makes sure the event to run only once
      this.once(id, function(result: { error: any }) {
        done(result.error);
      });
      //send the worker our task
      //childProcess.send() is a function that supported by nodejs cluster module
      //since master and worker (parent and children processes) dont share memory, the only way to communicate is via IPC channel
      worker.worker.send({ task: task, argument: argument, id: id });
    }
  }

  workerCount() {
    return this.workers.length;
  }
}

export let Worker = new WorkerService();
