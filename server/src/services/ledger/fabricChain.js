import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import env from '../../config/env.js';
import log from '../../utils/logger.js';

// Hyperledger Fabric adapter.
//
// The Fabric SDK packages are optional dependencies: a deployment that runs on
// the local hash chain should not have to install grpc. They are therefore
// imported dynamically, and a missing package surfaces as a clear init error
// rather than a crash at startup.

let gateway = null;
let grpcClient = null;
let contract = null;

async function loadSdk() {
  try {
    const [fabric, grpc] = await Promise.all([
      import('@hyperledger/fabric-gateway'),
      import('@grpc/grpc-js'),
    ]);
    return { fabric, grpc: grpc.default || grpc };
  } catch (err) {
    throw new Error(
      'FABRIC_ENABLED=true but the Fabric SDK is not installed. ' +
        'Run: npm install @hyperledger/fabric-gateway @grpc/grpc-js  ' +
        `(original error: ${err.message})`
    );
  }
}

function decode(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  return text.length ? JSON.parse(text) : null;
}

export const fabricChain = {
  backend: 'fabric',

  async init() {
    if (contract) return true;
    const { fabric, grpc } = await loadSdk();
    const { connect, signers, hash } = fabric;

    const [tlsCert, cert, key] = await Promise.all([
      fs.readFile(env.fabric.tlsCertPath),
      fs.readFile(env.fabric.certPath),
      fs.readFile(env.fabric.keyPath),
    ]);

    grpcClient = new grpc.Client(
      env.fabric.peerEndpoint,
      grpc.credentials.createSsl(tlsCert),
      { 'grpc.ssl_target_name_override': env.fabric.peerHostAlias }
    );

    gateway = connect({
      client: grpcClient,
      identity: { mspId: env.fabric.mspId, credentials: cert },
      signer: signers.newPrivateKeySigner(crypto.createPrivateKey(key)),
      hash: hash.sha256,
      // Rural uplinks are slow. These timeouts are deliberately generous;
      // a credential write is not on any student's critical path.
      evaluateOptions: () => ({ deadline: Date.now() + 15000 }),
      endorseOptions: () => ({ deadline: Date.now() + 30000 }),
      submitOptions: () => ({ deadline: Date.now() + 30000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });

    const network = gateway.getNetwork(env.fabric.channel);
    contract = network.getContract(env.fabric.chaincode);
    log.info(`fabric connected: ${env.fabric.channel}/${env.fabric.chaincode}`);
    return true;
  },

  async close() {
    gateway?.close();
    grpcClient?.close();
    gateway = grpcClient = contract = null;
  },

  async issueCredential(record) {
    await this.init();
    const proposal = contract.newProposal('IssueCredential', {
      arguments: [JSON.stringify(record)],
    });
    const txn = await (await proposal.endorse()).submit();
    const status = await txn.getStatus();
    if (!status.successful) {
      throw new Error(`fabric commit failed with code ${status.code}`);
    }
    return {
      txId: txn.getTransactionId(),
      blockNumber: Number(status.blockNumber),
      hash: record.payloadHash,
      timestamp: new Date(),
    };
  },

  async revokeCredential(credentialId, reason) {
    await this.init();
    const proposal = contract.newProposal('RevokeCredential', {
      arguments: [credentialId, reason || ''],
    });
    const txn = await (await proposal.endorse()).submit();
    const status = await txn.getStatus();
    if (!status.successful) {
      throw new Error(`fabric commit failed with code ${status.code}`);
    }
    return {
      txId: txn.getTransactionId(),
      blockNumber: Number(status.blockNumber),
      timestamp: new Date(),
    };
  },

  async getCredential(credentialId) {
    await this.init();
    try {
      return decode(await contract.evaluateTransaction('GetCredential', credentialId));
    } catch (err) {
      if (/does not exist/i.test(err.message)) return null;
      throw err;
    }
  },

  async getHistory(credentialId) {
    await this.init();
    return decode(await contract.evaluateTransaction('GetHistory', credentialId)) || [];
  },

  async verifyByHash(payloadHash) {
    await this.init();
    const result = decode(await contract.evaluateTransaction('VerifyByHash', payloadHash));
    return result || { found: false };
  },

  // Fabric guarantees chain integrity at the ordering-service level; there is
  // no application-side walk to perform. Report liveness instead.
  async verifyChain() {
    await this.init();
    const info = decode(await contract.evaluateTransaction('LedgerStats'));
    return { intact: true, backend: 'fabric', ...info };
  },
};

export default fabricChain;
