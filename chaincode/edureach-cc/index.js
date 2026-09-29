'use strict';

const CredentialContract = require('./lib/credentialContract.js');

// fabric-chaincode-node reads this export to discover the contracts to expose.
module.exports.CredentialContract = CredentialContract;
module.exports.contracts = [CredentialContract];
