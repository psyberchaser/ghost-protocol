import { expect } from "chai";
import { ethers } from "hardhat";

const Stage = {
  Lock: 0,
  Burn: 1,
  Mint: 2,
} as const;

const Step = {
  Lock: 0,
  Burn: 1,
  Mint: 2,
} as const;

describe("Ghost Wallet MVP", () => {
  async function deployFixture() {
    const [owner, alice, validator, recipient] = await ethers.getSigners();
    const GhostToken = await ethers.getContractFactory("GhostERC20");
    const sourceToken = await GhostToken.deploy("Source Token", "SRC", owner.address);
    const destinationToken = await GhostToken.deploy("Dest Token", "DST", owner.address);
    const stakingToken = await GhostToken.deploy("Stake Token", "STK", owner.address);

    const stakeAmount = ethers.parseEther("5000");
    await stakingToken.grantRole(await stakingToken.MINTER_ROLE(), owner.address);
    await stakingToken.mint(validator.address, stakeAmount);

    const ValidatorSet = await ethers.getContractFactory("ValidatorSlashing");
    const validatorSet = await ValidatorSet.deploy(await stakingToken.getAddress());
    await stakingToken.connect(validator).approve(await validatorSet.getAddress(), stakeAmount);
    await validatorSet.connect(validator).joinAsValidator(stakeAmount);

    const ZKProofSystem = await ethers.getContractFactory("ZKProofSystem");
    const zkSystem = await ZKProofSystem.deploy();

    const GhostVerifier = await ethers.getContractFactory("GhostZKVerifier");
    const ghostVerifier = await GhostVerifier.deploy(owner.address, await zkSystem.getAddress());
    await ghostVerifier.setValidatorRegistry(await validatorSet.getAddress());

    const GhostWallet = await ethers.getContractFactory("GhostWallet");
    const ghostWallet = await GhostWallet.deploy(
      owner.address,
      await ghostVerifier.getAddress(),
      await validatorSet.getAddress()
    );

    const MasterBridge = await ethers.getContractFactory("MasterBridge");
    const masterBridge = await MasterBridge.deploy(owner.address, await ghostWallet.getAddress());
    await masterBridge.setValidatorRegistry(await validatorSet.getAddress());
    await masterBridge.setValidatorThreshold(1);
    await masterBridge.setSupportedToken(await sourceToken.getAddress(), true);

    await ghostWallet.setLocalValidator(await masterBridge.getAddress(), true);
    await ghostWallet.setLocalValidator(validator.address, true);
    await ghostVerifier.setLocalValidator(validator.address, true);
    await masterBridge.setLocalValidator(validator.address, true);
    await destinationToken.grantRole(await destinationToken.MINTER_ROLE(), await ghostWallet.getAddress());

    await sourceToken.grantRole(await sourceToken.MINTER_ROLE(), owner.address);
    await sourceToken.mint(alice.address, ethers.parseEther("1000"));

    return {
      owner,
      alice,
      validator,
      recipient,
      sourceToken,
      destinationToken,
      stakingToken,
      validatorSet,
      zkSystem,
      ghostVerifier,
      ghostWallet,
      masterBridge,
    };
  }

  function encodeBytes32(value: string) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return coder.encode(["bytes32"], [value]);
  }

  function encodeMintPayload(snark: string, stark: string, recipient: string) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const proofBytes = coder.encode(
      ["bytes32", "bytes32"],
      [snark as `0x${string}`, stark as `0x${string}`]
    );
    return coder.encode(["bytes", "address"], [proofBytes, recipient]);
  }

  async function generateValidSnarkProof(
    zkSystem: any,
    validatorSigner: any,
    ghostId: string,
    amount: bigint,
    label: string
  ) {
    const commitment = ethers.keccak256(ethers.toUtf8Bytes(label));
    const eventTopic = ethers.id("SNARKProofGenerated(bytes32,bytes32)");
    const zkAddress = await zkSystem.getAddress();
    for (let salt = 1; salt < 64; salt++) {
      const tx = await zkSystem.connect(validatorSigner).generateSNARKProof(ghostId, amount, salt, commitment);
      const receipt = await tx.wait();
      let proofId: string | null = null;
      for (const log of receipt?.logs || []) {
        if (log.address === zkAddress && log.topics[0] === eventTopic) {
          const parsed = zkSystem.interface.parseLog(log);
          proofId = parsed.args.proofId as string;
          break;
        }
      }
      if (!proofId) continue;
      const ok = await zkSystem.connect(validatorSigner).verifySNARKProof(proofId);
      if (ok) {
        return proofId as string;
      }
    }
    throw new Error("unable to build snark proof");
  }

  async function generateStarkProof(
    zkSystem: any,
    validatorSigner: any,
    ghostId: string,
    history: string[],
    stateRoot: string
  ) {
    const eventTopic = ethers.id("STARKProofGenerated(bytes32,bytes32)");
    const zkAddress = await zkSystem.getAddress();
    const tx = await zkSystem.connect(validatorSigner).generateSTARKProof(ghostId, history, stateRoot);
    const receipt = await tx.wait();
    for (const log of receipt?.logs || []) {
      if (log.address === zkAddress && log.topics[0] === eventTopic) {
        const parsed = zkSystem.interface.parseLog(log);
        const proofId = parsed.args.proofId as string;
        await zkSystem.connect(validatorSigner).verifySTARKProof(proofId);
        return proofId;
      }
    }
    throw new Error("unable to capture stark proof");
  }

  it("runs lifecycle with SNARK/STARK verifier + multisig master", async () => {
    const fixture = await deployFixture();
    const {
      alice,
      validator,
      recipient,
      sourceToken,
      destinationToken,
      zkSystem,
      ghostVerifier,
      ghostWallet,
      masterBridge,
    } = fixture;
    if (!zkSystem) {
      throw new Error("zk system missing");
    }

    const amount = ethers.parseEther("100");
    await sourceToken.connect(alice).approve(await masterBridge.getAddress(), amount);

    const tx = await masterBridge
      .connect(alice)
      .initiateGhostBridge(
        await sourceToken.getAddress(),
        await destinationToken.getAddress(),
        111,
        ethers.toUtf8Bytes("dest:btc"),
        recipient.address,
        amount,
        ethers.keccak256(ethers.toUtf8Bytes("commitment"))
      );
    const receipt = await tx.wait();
    const masterBridgeAddress = await masterBridge.getAddress();
    const log = receipt?.logs.find((entry) => entry.address === masterBridgeAddress);
    if (!log) throw new Error("missing ghost log");
    const ghostId = masterBridge.interface.parseLog(log).args.ghostId as string;

    const snarkProofId = await generateValidSnarkProof(zkSystem, validator, ghostId, amount, "amount");
    await ghostVerifier.connect(validator).bindProof(ghostId, Stage.Lock, encodeBytes32(snarkProofId));
    await masterBridge.connect(validator).approveStep(ghostId, Step.Lock, encodeBytes32(snarkProofId));

    const starkProofId = await generateStarkProof(
      zkSystem,
      validator,
      ghostId,
      [ethers.keccak256(ethers.toUtf8Bytes("lock"))],
      ethers.keccak256(ethers.toUtf8Bytes("state"))
    );
    await ghostVerifier.connect(validator).bindProof(ghostId, Stage.Burn, encodeBytes32(starkProofId));
    await masterBridge.connect(validator).approveStep(ghostId, Step.Burn, encodeBytes32(starkProofId));

    await ghostVerifier
      .connect(validator)
      .bindProof(
        ghostId,
        Stage.Mint,
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "bytes32"],
          [snarkProofId as `0x${string}`, starkProofId as `0x${string}`]
        )
      );
    await masterBridge
      .connect(validator)
      .approveStep(ghostId, Step.Mint, encodeMintPayload(snarkProofId, starkProofId, recipient.address));

    await ghostWallet.connect(validator).settleGhost(ghostId);
    expect(await destinationToken.balanceOf(recipient.address)).to.equal(amount);
  });

  it("mirrors burn to remote chain and acknowledges mint", async () => {
    const remoteFixture = await deployFixture();
    const {
      alice,
      validator,
      recipient,
      sourceToken,
      destinationToken,
      zkSystem,
      ghostVerifier,
      ghostWallet,
      validatorSet,
    } = remoteFixture;
    if (!zkSystem) {
      throw new Error("zk system missing");
    }

    const GhostVerifier = await ethers.getContractFactory("GhostZKVerifier");
    const ghostVerifierDest = await GhostVerifier.deploy(validator.address, await zkSystem.getAddress());
    await ghostVerifierDest.connect(validator).setValidatorRegistry(await validatorSet.getAddress());
    await ghostVerifierDest.connect(validator).setLocalValidator(validator.address, true);

    const GhostWallet = await ethers.getContractFactory("GhostWallet");
    const ghostWalletDest = await GhostWallet.deploy(
      validator.address,
      await ghostVerifierDest.getAddress(),
      await validatorSet.getAddress()
    );
    await ghostWalletDest.connect(validator).setLocalValidator(validator.address, true);
    await destinationToken.grantRole(await destinationToken.MINTER_ROLE(), await ghostWalletDest.getAddress());

    const amount = ethers.parseEther("25");
    await sourceToken.connect(alice).approve(await ghostWallet.getAddress(), amount);

    const initTx = await ghostWallet
      .connect(alice)
      .initiateGhost(
        alice.address,
        await sourceToken.getAddress(),
        await destinationToken.getAddress(),
        222,
        ethers.toUtf8Bytes("remote"),
        recipient.address,
        amount,
        ethers.ZeroHash
      );
    const initReceipt = await initTx.wait();
    const ghostWalletAddress = await ghostWallet.getAddress();
    const initLog = initReceipt?.logs.find((entry) => entry.address === ghostWalletAddress);
    if (!initLog) throw new Error("missing initiate log");
    const ghostId = ghostWallet.interface.parseLog(initLog).args.ghostId as string;

    const snarkProofId = await generateValidSnarkProof(zkSystem, validator, ghostId, amount, "remote");
    await ghostVerifier.connect(validator).bindProof(ghostId, Stage.Lock, encodeBytes32(snarkProofId));
    await ghostWallet.connect(validator).lockGhost(ghostId, encodeBytes32(snarkProofId));

    const starkProofId = await generateStarkProof(
      zkSystem,
      validator,
      ghostId,
      [ethers.keccak256(ethers.toUtf8Bytes("lock")), ethers.keccak256(ethers.toUtf8Bytes("burn"))],
      ethers.keccak256(ethers.toUtf8Bytes("remote-state"))
    );
    await ghostVerifier.connect(validator).bindProof(ghostId, Stage.Burn, encodeBytes32(starkProofId));
    await ghostWallet.connect(validator).burnGhost(ghostId, encodeBytes32(starkProofId));

    await ghostWalletDest
      .connect(validator)
      .mirrorGhost(
        ghostId,
        await sourceToken.getAddress(),
        await destinationToken.getAddress(),
        31337,
        31337,
        ethers.toUtf8Bytes("remote"),
        recipient.address,
        amount,
        ethers.keccak256(encodeBytes32(starkProofId)),
        (await ethers.provider.getBlock("latest"))!.timestamp
      );

    await ghostVerifierDest
      .connect(validator)
      .bindProof(
        ghostId,
        Stage.Mint,
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "bytes32"],
          [snarkProofId as `0x${string}`, starkProofId as `0x${string}`]
        )
      );

    await ghostWalletDest.connect(validator).mintGhost(
      ghostId,
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32"],
        [snarkProofId as `0x${string}`, starkProofId as `0x${string}`]
      ),
      recipient.address
    );
    await ghostWalletDest.connect(validator).settleGhost(ghostId);

    await ghostWallet.connect(validator).confirmRemoteMint(ghostId);
    await ghostWallet.connect(validator).settleGhost(ghostId);

    expect(await destinationToken.balanceOf(recipient.address)).to.equal(amount);
  });
});
