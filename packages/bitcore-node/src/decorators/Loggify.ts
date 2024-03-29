import logger from '../logger';
//import util from 'util';
import parseArgv from "../utils/parseArgv";
export const PerformanceTracker = {};
let args = parseArgv([], ['DEBUG']);

//TODO low: to learn more
//i have the impression that, loggify will only log down the public functions of the target ts/js file/class
export function SavePerformance(logPrefix, startTime, endTime) {
  const totalTime = endTime.getTime() - startTime.getTime();
  if (!PerformanceTracker[logPrefix]) {
    PerformanceTracker[logPrefix] = {
      time: totalTime,
      count: 1,
      avg: totalTime
    };
  } else {
    PerformanceTracker[logPrefix].time += totalTime;
    PerformanceTracker[logPrefix].count++;
    PerformanceTracker[logPrefix].avg = PerformanceTracker[logPrefix].time / PerformanceTracker[logPrefix].count;
  }
}


export function LoggifyClass<T extends { new(...args: any[]): {} }>(
  aClass: T
) {
  if (!args.DEBUG) {
    return aClass;
  }
  return class extends aClass {
    constructor(...args: any[]) {
      super(...args);
      //YCM temp comment out
      //logger.debug(`Loggifying ${aClass.name} with args:: ${util.inspect(args)}`);
      for (let prop of Object.getOwnPropertyNames(aClass.prototype)) {
        if (typeof this[prop] === 'function') {
          logger.debug(`Loggifying  ${aClass.name}::${prop}`);
          this[prop] = LoggifyFunction(this[prop], `${aClass.name}::${prop}`, this);
        }
      }
    }
  };
}


export function LoggifyFunction(fn: Function, logPrefix: string = '', bind?: any) {
  if (!args.DEBUG) {
    return fn as (...methodargs: any[]) => any;
  }
  let copy = fn;
  if (bind) {
    copy = copy.bind(bind);
  }
  return function (...methodargs: any[]) {
    const startTime = new Date();
    logger.debug(`${logPrefix}::called::`);
    let returnVal = copy(...methodargs);
    if (returnVal && <Promise<any>>returnVal.then) {
      returnVal
        .catch((err: any) => {
          logger.error(`${logPrefix}::catch::${err}`);
          throw err;
        })
        .then((data: any) => {
          logger.debug(`${logPrefix}::resolved::`);
          SavePerformance(logPrefix, startTime, new Date());
          return data;
        });
    } else {
      SavePerformance(logPrefix, startTime, new Date());
      logger.debug(`${logPrefix}::returned::`);
    }
    return returnVal;
  };
}

export function LoggifyObject(obj: any, logPrefix: string = '', bind?: any) {
  if (!args.DEBUG) {
    return obj;
  }
  for (let prop of Object.getOwnPropertyNames(obj)) {
    if (typeof obj[prop] === 'function') {
      let copy = obj[prop];
      if (bind) {
        copy = copy.bind(bind);
      }
      //YCM temp comment out 
      //logger.debug(`Loggifying  ${logPrefix}::${prop}`);
      obj[prop] = LoggifyFunction(obj[prop], `${logPrefix}::${prop}`, bind);
    }
  }
  return obj;
}
