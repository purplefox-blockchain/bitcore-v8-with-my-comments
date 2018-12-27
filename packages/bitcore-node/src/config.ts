import { homedir, cpus } from 'os';
import parseArgv from './utils/parseArgv';
import ConfigType from './types/Config';
let program = parseArgv([], ['config']);

import logger from './logger';

function findConfig(): ConfigType | undefined {
  let foundConfig;
  const envConfigPath = process.env.BITCORE_CONFIG_PATH;
  const argConfigPath = program.config;
  const configFileName = 'bitcore.config.json';
  let bitcoreConfigPaths = [
    `${homedir()}/${configFileName}`,
    `../../../../${configFileName}`,
    `../../${configFileName}`
  ];
  const overrideConfig = argConfigPath || envConfigPath;
  if (overrideConfig) {
    bitcoreConfigPaths.unshift(overrideConfig);
  }
  // No config specified. Search home, bitcore and cur directory
  //TODO low: how does it search the current directory?
  for (let path of bitcoreConfigPaths) {
    if (!foundConfig) {
      try {
        //my interpretation: const expanded = (path[0]==='~') ? path.replace('~', homedir()) : path;
        const expanded = path[0] === '~' ? path.replace('~', homedir()) : path;
        logger.debug('YCM config.ts trying to find bitcore config',expanded);
        //bitcoreNode is a ConfigType, which is defined in types/Config.ts
        //essentially we map the bitcore.config.json to this interface object
        const bitcoreConfig = require(expanded) as { bitcoreNode: ConfigType };
        foundConfig = bitcoreConfig.bitcoreNode;
        logger.debug('YCM config.ts found bitcore config')
      } catch (e) {
        foundConfig = undefined;
      }
    }
  }
  return foundConfig;
}

function setTrustedPeers(config: ConfigType): ConfigType {
  for (let [chain, chainObj] of Object.entries(config)) {
    for (let network of Object.keys(chainObj)) {
      let env = process.env;
      const envString = `TRUSTED_${chain.toUpperCase()}_${network.toUpperCase()}_PEER`;
      if (env[envString]) {
        let peers = config.chains[chain][network].trustedPeers || [];
        peers.push({
          host: env[envString],
          port: env[`${envString}_PORT`]
        });
        config.chains[chain][network].trustedPeers = peers;
      }
    }
  }
  return config;
}

//this is exported, also is what being called in storage.ts
const Config = function(): ConfigType {
  //preset values
  //it is very smart to set num workers to cpu count cpus().length,
  //ORIGINAL CODE:
  //numWorkers: cpus().length,
  let config: ConfigType = {
    maxPoolSize: 50,
    port: 3000,
    dbHost: process.env.DB_HOST || '127.0.0.1',
    dbName: process.env.DB_NAME || 'bitcore',
    dbPort: process.env.DB_PORT || '27017',
    numWorkers: 1,
    chains: {}
  };
  logger.info(`YCM config.ts !!! IMPORTANT: in this local machine, I force the worker limit to be 1, downsized from ${cpus().length}`);

  //customized values from bitcore.config.json
  let foundConfig = findConfig();
  //merge both
  Object.assign(config, foundConfig, {});
  //if "chains" is not defined, we add a default btc chain pointing to localhost
  if (!Object.keys(config.chains).length) {
    Object.assign(config.chains, {
      BTC: {
        mainnet: {
          chainSource: 'p2p',
          trustedPeers: [{ host: '127.0.0.1', port: 8333 }],
          rpc: {
            host: '127.0.0.1',
            port: 8332,
            username: 'bitcoin',
            password: 'bitcoin'
          }
        }
      }
    });
  }
  config = setTrustedPeers(config);
  return config;
};

export default Config();
