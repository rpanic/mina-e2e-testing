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
    MerkleMap,
    Experimental, VerificationKey,
} from 'snarkyjs';
import * as fs from 'fs';
import { LendableToken, TokenUserEvent } from './LendableToken';
import { tic, toc } from '../tictoc';
import {
    BorrowEvent,
    LENDING_MERKLE_HEIGHT,
    LendingMerkleWitness,
    LiquidityAddEvent,
    ValuedMerkleTreeWitness,
} from './model';
import { sleep, structArrayToFields, TransactionId } from '../utils';
import { Lender, staticWitnessService } from './Lender';
import {
    EventResponse,
    EXTENDED_JEST_TIMEOUT,
    getTestContext,
    it2,
} from '../JestExtensions';
import { expect } from '@jest/globals';
import { WitnessService } from './WitnessService';
import {LenderTokenHolder} from "./LenderTokenHolder";

describe('lending - e2e', () => {
    let context = getTestContext();

    let accounts: PrivateKey[],
        deployToBerkeley = context.berkeley;

    async function deployNewToken(
        symbol: string
    ): Promise<{ tx: TransactionId; pk: PrivateKey }> {
        let pk = PrivateKey.random();
        let deployArgs = await context.getDeployArgs(pk, LendableToken);

        let tx = await Mina.transaction(
            { sender: accounts[0].toPublicKey(), fee: context.defaultFee },
            () => {
                AccountUpdate.fundNewAccount(accounts[0].toPublicKey(), 2);

                let contract = new LendableToken(pk.toPublicKey());
                contract.deployToken(
                    deployArgs,
                    context.editPermission,
                    symbol
                );
            }
        );
        await context.signOrProve(tx, accounts[0], [accounts[0], pk]);

        console.log(
            'Deploying Token ' + symbol + ' to ' + pk.toPublicKey().toBase58()
        );

        return { tx: await tx.send(), pk };
    }

    async function deployLender(
        witnessService: WitnessService,
        tokenPk: PrivateKey,
        nonce?: number
    ): Promise<{ tx: TransactionId; pk: PrivateKey }> {
        let pk = PrivateKey.random();

        console.log('Deploying Lender to ' + pk.toPublicKey().toBase58());

        let tokenHolderDeployArgs = await context.getDeployArgs(pk, LenderTokenHolder)

        let deployArgs = await context.getDeployArgs(pk, Lender);

        let tx = await Mina.transaction(
            {
                sender: accounts[0].toPublicKey(),
                fee: context.defaultFee,
                nonce: nonce,
            },
            () => {
                AccountUpdate.fundNewAccount(accounts[0].toPublicKey(), 2);

                //AU1
                let contract = Lender.getInstance(
                    pk.toPublicKey(),
                    witnessService
                );
                contract.deploy(deployArgs);

                let token = new LendableToken(tokenPk.toPublicKey())
                if(context.proofs){
                    token.deployZkapp(pk.toPublicKey(), LenderTokenHolder._verificationKey!)
                }else{
                    token.deployZkappSignature(pk.toPublicKey())
                    token.requireSignature()
                }
                // let tokenHolder = new LenderTokenHolder(pk.toPublicKey(), token.token.id)
                // tokenHolder.deploy(tokenHolderDeployArgs)
            }
        );
        await context.signOrProve(tx, accounts[0], [accounts[0], pk, tokenPk]);

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
    }, EXTENDED_JEST_TIMEOUT);

    afterAll(() => {
        setInterval(shutdown, 400);
    });

    let tokenPreMint = 1000000000n;

    it2(
        `Basic token functionality - berkeley: ${deployToBerkeley}, proofs: ${context.proofs}`,
        async () => {
            let deployResult = await deployNewToken('TOKEN1');
            await deployResult.tx.wait();
            let tokenPk = deployResult.pk;
            let token = new LendableToken(tokenPk.toPublicKey());

            let tokenAccount = await context.getAccount(token.address);

            //Check account state after deployment
            expect(tokenAccount.tokenSymbol).toEqual('TOKEN1');
            expect(tokenAccount.nonce).toEqual(UInt32.from(1));

            expect(tokenAccount.permissions.editState).toEqual(
                context.editPermission
            );
            expect(tokenAccount.permissions.setTokenSymbol).toEqual(
                context.editPermission
            );
            expect(tokenAccount.permissions.send).toEqual(
                context.editPermission
            );
            expect(tokenAccount.permissions.receive).toEqual(
                context.editPermission
            );
            expect(tokenAccount.permissions.editSequenceState).toEqual(
                context.editPermission
            );

            let balance = token.getBalance(accounts[0].toPublicKey());
            expect(balance.toBigInt()).toEqual(tokenPreMint);

            let amount = UInt64.from(1000);
            let signature = Signature.create(
                accounts[0],
                structArrayToFields(
                    amount,
                    accounts[1].toPublicKey(),
                    token.token.id
                )
            );
            let tx = await Mina.transaction(
                { sender: accounts[0].toPublicKey(), fee: context.defaultFee },
                () => {
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
                }
            );
            await context.signOrProve(tx, accounts[0], [tokenPk]);

            let txId = await tx.send();
            await txId.wait();

            let balance1 = token.getBalance(accounts[0].toPublicKey());
            expect(balance1.toBigInt()).toEqual(
                tokenPreMint - amount.toBigInt()
            );

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
            expect(decodedEvents[0].event.receiver).toEqual(
                accounts[0].toPublicKey()
            );
            expect(decodedEvents[0].event.amount).toEqual(
                UInt64.from(tokenPreMint)
            );

            //Check sendTokens transfer event
            expect(decodedEvents[1].index).toEqual('0');
            expect(decodedEvents[1].event.sender).toEqual(
                accounts[0].toPublicKey()
            );
            expect(decodedEvents[1].event.receiver).toEqual(
                accounts[1].toPublicKey()
            );
            expect(decodedEvents[1].event.amount).toEqual(amount);
        },
        EXTENDED_JEST_TIMEOUT
    );

    it(
        `Adding Liquidity - berkeley: ${deployToBerkeley}, proofs: ${context.proofs}`,
        async () => {
            let witnessService = staticWitnessService;
            witnessService.initUser(accounts[0].toPublicKey().toBase58());

            let account = await context.getAccount(accounts[0].toPublicKey());
            expect(account).toBeDefined();
            let startingNonce = Number(account.nonce.toBigint());

            //Deploy a test token
            let tokenDeployResult = await deployNewToken('LT1');
            let tokenPk = tokenDeployResult.pk;
            let token = new LendableToken(tokenPk.toPublicKey());

            try {
                let lenderDeployResult = await deployLender(
                    witnessService,
                    tokenPk,
                    startingNonce + 1
                );
                let lenderPk = lenderDeployResult.pk;

                let lender = Lender.getInstance(
                    lenderPk.toPublicKey(),
                    witnessService
                );
                let tokenHolder = new LenderTokenHolder(lenderPk.toPublicKey(), token.token.id)

                let amount = UInt64.from(10000);

                let tx3 = await Mina.transaction(
                    {sender: accounts[0].toPublicKey(), fee: context.defaultFee},
                    () => {
                        // AccountUpdate.fundNewAccount(
                        //     accounts[0].toPublicKey(),
                        //     1
                        // ).requireSignature();

                        let tokenAu = AccountUpdate.createSigned(
                            accounts[0].toPublicKey(),
                            token.token.id
                        );
                        tokenAu.balance.subInPlace(amount);

                        lender.addLiquidity(tokenAu, token.address, amount);
                        if (!context.proofs) {
                            tokenAu.requireSignature();
                            lender.requireSignature();
                            lender.self.children.accountUpdates.forEach((x) =>
                                x.requireSignature()
                            );
                        }
                    }
                );
                await context.signOrProve(tx3, accounts[0], [lenderPk, tokenPk]);
                let tx3Id = await tx3.send();

                await tokenDeployResult.tx.wait();
                await lenderDeployResult.tx.wait();
                await tx3Id.wait();

                let state =
                    (await context.getAccount(lender.address)).zkapp?.appState ??
                    [];
                expect(state[0]).toEqual(WitnessService.emptyMerkleRoot);
                expect(state[1]).toEqual(Field(0));

                //Check emitted LiquidityAddEvent
                await sleep(4000);
                let events1 = (await Mina.fetchEvents(
                    lender.address,
                    Field(1)
                )) as EventResponse[];
                expect(events1.length).toEqual(1);

                let [index, ...eventData1] = events1[0].events[0];
                expect(index).toEqual('1');
                let liquidityAddEvent = LiquidityAddEvent.fromFields(
                    eventData1.map(Field)
                );
                expect(liquidityAddEvent.amount).toEqual(amount);
                expect(liquidityAddEvent.tokenId).toEqual(token.token.id);
                expect(liquidityAddEvent.account).toEqual(
                    accounts[0].toPublicKey()
                );

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

                lender = Lender.getInstance(lenderPk.toPublicKey(), witnessService);
                //Rollup Liquidity
                let tx2 = await Mina.transaction(
                    {sender: accounts[0].toPublicKey(), fee: context.defaultFee},
                    () => {
                        try {
                            lender.rollupLiquidity();
                        } catch (e) {
                            console.log('Exception at rollup:');
                            console.log(e);
                            throw e;
                        }
                        if (!context.proofs) {
                            lender.requireSignature();
                        }
                    }
                );
                await context.signOrProve(tx2, accounts[0], [lenderPk]);
                await (await tx2.send()).wait();

                let contractAccount0 = await context.getAccount(lender.address);
                expect(contractAccount0.zkapp?.appState[0]).toEqual(
                    witnessService.userLiquidityMap.getRoot()
                );

                // --------- Borrowing
                let borrowAmount = amount.div(2);
                let signature = Signature.create(
                    accounts[0],
                    structArrayToFields(
                        lender.signature_prefixes['borrow'],
                        token.address,
                        borrowAmount
                    )
                );

                let [borrowWitness, borrowUserInfo] =
                    witnessService.getBorrowWitness(
                        accounts[0].toPublicKey(),
                        borrowAmount
                    );

                lender = Lender.getInstance(lenderPk.toPublicKey(), witnessService);
                let tx4 = await Mina.transaction(
                    {sender: accounts[0].toPublicKey(), fee: context.defaultFee},
                    () => {
                        // let approveSendingCallback = Experimental.Callback.create(
                        //     tokenHolder,
                        //     'approveSend',
                        //     [borrowAmount]
                        // );
                        // approveSendingCallback.accountUpdate.tokenId = token.token.id

                        lender.borrow(
                            token.address,
                            token.token.id,
                            borrowAmount,
                            signature,
                            borrowWitness,
                            borrowUserInfo,
                            // approveSendingCallback
                        );
                        if (!context.proofs) {
                            lender.requireSignature();
                            lender.self.children.accountUpdates.forEach((x) => {
                                x.requireSignature();
                                x.children.accountUpdates.forEach((y) => {
                                    y.requireSignature()
                                    y.children.accountUpdates.forEach((z) =>
                                        z.requireSignature()
                                    );
                                });
                            });
                        }
                    }
                );

                console.log(tx4.toPretty());

                tx4.transaction.accountUpdates.forEach((x) =>
                    console.log(x.toJSON())
                );

                await context.signOrProve(tx4, accounts[0], [lenderPk, tokenPk]);
                await (await tx4.send()).wait();

                let borrowAccount0 = await context.getAccount(
                    accounts[0].toPublicKey(),
                    token.token.id
                );

                expect(borrowAccount0.balance.toString()).toEqual(
                    UInt64.from(LendableToken.INITIAL_MINT)
                        .sub(amount)
                        .add(borrowAmount)
                        .toString()
                );

                let contractAccount1Token = await context.getAccount(
                    lender.address,
                    token.token.id
                );
                expect(contractAccount1Token.balance).toEqual(
                    amount.sub(borrowAmount)
                );
                let contractAccount1 = await context.getAccount(lender.address);
                expect(contractAccount1.zkapp?.appState[0]).toEqual(
                    witnessService.userLiquidityMap.getRoot()
                );

                //Borrow event
                await sleep(4000);
                let events2 = (await Mina.fetchEvents(lender.address, Field(1), {
                    from: UInt32.from(0),
                })) as EventResponse[];
                expect(events2.length).toEqual(2);

                let [index2, ...eventData2] = events2[1].events[0];
                expect(index2).toEqual('0');
                console.log('7');
                let borrowEvent = BorrowEvent.fromFields(eventData2.map(Field));
                expect(borrowEvent.amount).toEqual(borrowAmount);
                expect(borrowEvent.tokenId).toEqual(token.token.id);
                expect(borrowEvent.account).toEqual(accounts[0].toPublicKey());
                console.log('8');
            }catch(e){
                console.log(e)
            }
        },
        EXTENDED_JEST_TIMEOUT
    );

    // it(`3 not equals 5 - berkeley?: ${deployToBerkeley}`, () => {
    //     expect(3).not.toEqual(5);
    // });
});
