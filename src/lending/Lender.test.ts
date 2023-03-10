import {
  AccountUpdate,
  MerkleTree,
  Mina,
  Poseidon,
  PrivateKey,
  PublicKey,
  shutdown,
  Signature,
  UInt64,
  Field,
  UInt32,
} from 'snarkyjs';
import * as fs from 'fs';
import { LendableToken, TokenUserEvent } from './LendableToken';
import { tic, toc } from '../tictoc';
import {
  LENDING_MERKLE_HEIGHT,
  LendingMerkleWitness,
  ValuedMerkleTreeWitness,
} from './model';
import { structArrayToFields, TransactionId } from '../utils';
import { Lender, staticWitnessService, WitnessService } from './Lender';
import {EventResponse, getTestContext, it2} from '../JestExtensions';
import { expect } from '@jest/globals';

describe('lending - e2e', () => {
  let context = getTestContext();

  let accounts: PrivateKey[],
    deployToBerkeley = context.berkeley;

  async function deployNewToken(
    symbol: string
  ): Promise<{ tx: TransactionId; pk: PrivateKey }> {
    let pk = PrivateKey.random();
    let deployArgs = await context.getDeployArgs(pk, LendableToken);
    let tx = await Mina.transaction(accounts[0].toPublicKey(), () => {
      AccountUpdate.fundNewAccount(accounts[0].toPublicKey(), 2);

      let contract = new LendableToken(pk.toPublicKey());
      contract.deployToken(deployArgs, context.editPermission, symbol);
    });
    await context.signOrProve(tx, accounts[0], [accounts[0], pk]);

    console.log(
      'Deploying Token ' + symbol + ' to ' + pk.toPublicKey().toBase58()
    );

    return { tx: await tx.send(), pk };
  }

  async function deployLender(
    witnessService: WitnessService,
    nonce?: number
  ): Promise<{ tx: TransactionId; pk: PrivateKey }> {
    let pk = PrivateKey.random();
    let deployArgs = await context.getDeployArgs(pk, Lender);

    let tx = await Mina.transaction(
      { sender: accounts[0].toPublicKey(), nonce: nonce },
      () => {
        AccountUpdate.fundNewAccount(accounts[0].toPublicKey(), 1);

        //AU1
        let contract = Lender.getInstance(pk.toPublicKey(), witnessService);
        contract.deploy(deployArgs);
      }
    );
    await context.signOrProve(tx, accounts[0], [accounts[0], pk]);

    console.log('Deploying Lender to ' + pk.toPublicKey().toBase58());

    return { tx: await tx.send(), pk };
  }

  beforeAll(async () => {
    await context.before();

    accounts = context.accounts;

    console.log(
      accounts
        .map((x, i) => i + ': ' + x.toPublicKey().toBase58())
        .reduce((a, b, i) => a + '\n' + b)
    );
  });

  afterAll(() => {
    setInterval(shutdown, 0);
  });

  let tokenPreMint = 1000000000n;

  it(`Basic token functionality - berkeley: ${deployToBerkeley}, proofs: ${context.proofs}`, async () => {
    let deployResult = await deployNewToken('TOKEN1');
    await deployResult.tx.wait();
    let tokenPk = deployResult.pk;
    let token = new LendableToken(tokenPk.toPublicKey());

    let tokenAccount = await context.getAccount(token.address);

    //Check account state after deployment
    expect(tokenAccount.tokenSymbol).toEqual('TOKEN1');
    expect(tokenAccount.nonce).toEqual(UInt32.from(1));

    expect(tokenAccount.permissions.editState).toEqual(context.editPermission);
    expect(tokenAccount.permissions.setTokenSymbol).toEqual(
      context.editPermission
    );
    expect(tokenAccount.permissions.send).toEqual(context.editPermission);
    expect(tokenAccount.permissions.receive).toEqual(context.editPermission);
    expect(tokenAccount.permissions.editSequenceState).toEqual(
      context.editPermission
    );

    let balance = token.getBalance(accounts[0].toPublicKey());
    expect(balance.toBigInt()).toEqual(tokenPreMint);

    let amount = UInt64.from(1000);
    let signature = Signature.create(
      accounts[0],
      structArrayToFields(amount, accounts[1].toPublicKey(), token.token.id)
    );
    let tx = await Mina.transaction(accounts[0].toPublicKey(), () => {
      AccountUpdate.fundNewAccount(accounts[0].toPublicKey(), 1);

      token.sendTokens(
        accounts[0].toPublicKey(),
        signature,
        accounts[1].toPublicKey(),
        amount
      );
      if (!context.proofs) {
        token.requireSignature();
      }
    });
    await context.signOrProve(tx, accounts[0], [tokenPk]);

    let txId = await tx.send();
    await txId.wait();

    let balance1 = token.getBalance(accounts[0].toPublicKey());
    expect(balance1.toBigInt()).toEqual(tokenPreMint - amount.toBigInt());

    let balance2 = token.getBalance(accounts[1].toPublicKey());
    expect(balance2).toEqual(amount);

    let events = (await Mina.fetchEvents(
      token.address,
      Field(1)
    )) as EventResponse[];

    expect(events.length).toEqual(2);

    let decodedEvents = events.map((event) => {
      return {
        index: event.events[0][0],
        event: TokenUserEvent.fromFields(
          event.events[0].slice(1).map((x) => Field(x))
        ),
      };
    });

    //Check deploy transfer event
    expect(decodedEvents[0].index).toEqual('0');
    expect(decodedEvents[0].event.sender).toEqual(PublicKey.empty());
    expect(decodedEvents[0].event.receiver).toEqual(accounts[0].toPublicKey());
    expect(decodedEvents[0].event.amount).toEqual(UInt64.from(tokenPreMint));

    //Check sendTokens transfer event
    expect(decodedEvents[1].index).toEqual('0');
    expect(decodedEvents[1].event.sender).toEqual(accounts[0].toPublicKey());
    expect(decodedEvents[1].event.receiver).toEqual(accounts[1].toPublicKey());
    expect(decodedEvents[1].event.amount).toEqual(amount);
  });

  it2(
    `Adding Liquidity - berkeley: ${deployToBerkeley}, proofs: ${context.proofs}`,
    async () => {
      let witnessService = staticWitnessService;
      let account = await context.getAccount(accounts[0].toPublicKey());

      expect(account).toBeDefined();
      let startingNonce = Number(account.nonce.toBigint());

      let tokenDeployResult = await deployNewToken('LT1');
      let tokenPk = tokenDeployResult.pk;
      let tokenAllowances = new MerkleTree(LENDING_MERKLE_HEIGHT);

      let lenderDeployResult = await deployLender(
        witnessService,
        startingNonce + 1
      );
      let lenderPk = lenderDeployResult.pk;

      let token = new LendableToken(tokenPk.toPublicKey());
      let lender = Lender.getInstance(lenderPk.toPublicKey(), witnessService);

      await tokenDeployResult.tx.wait();
      await lenderDeployResult.tx.wait();

      let amount = UInt64.from(10000);
      let approveSignature = Signature.create(
        accounts[0],
        structArrayToFields(amount, lender.address, token.token.id)
      );
      let allowanceIndex = Poseidon.hash(
        structArrayToFields(accounts[0].toPublicKey(), lender.address)
      );
      let witness = new LendingMerkleWitness(
        tokenAllowances.getWitness(allowanceIndex.toBigInt()) //Witness is same for all indizes because tree is empty
      );

      let tx = await Mina.transaction(
        { sender: accounts[0].toPublicKey(), nonce: startingNonce + 2 },
        () => {
          token.approveTokens(
            accounts[0].toPublicKey(),
            approveSignature,
            lender.address,
            amount,
            witness,
            Field(0)
          );
          if (!context.proofs) {
            token.requireSignature();
          }
        }
      );
      await context.signOrProve(tx, accounts[0], [tokenPk]);
      await (await tx.send()).wait();

      let tx3 = await Mina.transaction(accounts[0].toPublicKey(), () => {
        AccountUpdate.fundNewAccount(
          accounts[0].toPublicKey(),
          1
        ).requireSignature();

        lender.addLiquidity(
          token.address,
          amount,
          new ValuedMerkleTreeWitness({
            witness,
            value: amount.value,
          })
        );
        if (!context.proofs) {
          lender.requireSignature();
          lender.self.children.accountUpdates.forEach((x) =>
            x.requireSignature()
          );
        }
      });
      await context.signOrProve(tx3, accounts[0], [lenderPk, tokenPk]);
      tx3.transaction.accountUpdates.forEach((au) => console.log(au.toJSON()));
      await (await tx3.send()).wait();

      let state =
        (await context.getAccount(lender.address)).zkapp?.appState ?? [];
      expect(state[0]).toEqual(witnessService.emptyMerkleRoot);
      expect(state[1]).toEqual(Field(0));

      let deployerTokenAccount = await context.getAccount(
        accounts[0].toPublicKey(),
        token.token.id
      );
      expect(deployerTokenAccount.balance).toEqual(
        UInt64.from(tokenPreMint).sub(amount)
      );
      let lenderTokenAccount = await context.getAccount(
        lender.address,
        token.token.id
      );
      expect(lenderTokenAccount.balance).toEqual(amount);
      console.log('Checkpoint A7');

      let tx2 = await Mina.transaction(
        { sender: accounts[0].toPublicKey() },
        () => {
          lender.rollupLiquidity();
          if (!context.proofs) {
            lender.requireSignature();
          }
        }
      );
      console.log('Checkpoint A8');
      await context.signOrProve(tx2, accounts[0], [lenderPk]);
      await (await tx2.send()).wait();
    }
  );

  // it(`3 not equals 5 - berkeley?: ${deployToBerkeley}`, () => {
  //     expect(3).not.toEqual(5);
  // });
});
