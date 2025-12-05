extern crate alloc;

use alloc::vec::Vec;
use alloc::vec;
use alloc::format;

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = GhostInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Processor::process(program_id, accounts, instruction)
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum GhostInstruction {
    Initialize {
        admin: Pubkey,
        validator_threshold: u8,
        max_validators: u8,
    },
    SetValidator {
        validator: Pubkey,
        enabled: bool,
    },
    CreateGhost {
        ghost_id: [u8; 32],
        amount: u64,
        destination_chain: u64,
        destination_address: [u8; 64],
        source_token: Pubkey,
        destination_token: Pubkey,
    },
    LockGhost {
        ghost_id: [u8; 32],
    },
    BurnGhost {
        ghost_id: [u8; 32],
        burn_proof: [u8; 32],
    },
    MirrorGhost {
        ghost_id: [u8; 32],
        source_chain: u64,
        amount: u64,
        burn_proof: [u8; 32],
        source_token: Pubkey,
        destination_token: Pubkey,
    },
    MintGhost {
        ghost_id: [u8; 32],
        mint_proof: [u8; 32],
        recipient: Pubkey,
    },
    AcknowledgeRemote {
        ghost_id: [u8; 32],
    },
    DestroyGhost {
        ghost_id: [u8; 32],
    },
    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDITY POOL INSTRUCTIONS
    // ═══════════════════════════════════════════════════════════════════════
    
    /// Initialize a new liquidity pool
    InitializePool {
        pool_seed: [u8; 32],
    },
    
    /// Deposit SOL into the pool (LP gets shares)
    DepositToPool {
        amount: u64,
    },
    
    /// Withdraw SOL from pool (burn shares)
    WithdrawFromPool {
        shares: u64,
    },
    
    /// Execute an incoming cross-chain payment (relayer only)
    /// Sends SOL from pool to recipient
    ExecutePayment {
        intent_id: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    },
    
    /// Record incoming payment intent (from EVM)
    RecordPaymentIntent {
        intent_id: [u8; 32],
        sender_chain: u64,
        sender_address: [u8; 64],
        amount: u64,
        dest_token: Pubkey,
    },
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct ProgramConfig {
    pub admin: Pubkey,
    pub validator_threshold: u8,
    pub max_validators: u8,
    pub validators: Vec<Pubkey>,
}

impl ProgramConfig {
    pub fn space(max_validators: usize) -> usize {
        32 + 1 + 1 + 4 + max_validators * 32
    }

    pub fn is_validator(&self, key: &Pubkey) -> bool {
        self.validators.iter().any(|v| v == key)
    }

    pub fn assert_validator(&self, key: &Pubkey) -> Result<(), GhostError> {
        if self.is_validator(key) {
            Ok(())
        } else {
            Err(GhostError::UnauthorizedValidator)
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum GhostState {
    None,
    Created,
    Locked,
    Burned,
    Minted,
    Settled,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct GhostAccount {
    pub ghost_id: [u8; 32],
    pub initiator: Pubkey,
    pub source_token: Pubkey,
    pub destination_token: Pubkey,
    pub destination_chain: u64,
    pub destination_address: [u8; 64],
    pub state: GhostState,
    pub amount: u64,
    pub lock_ts: i64,
    pub burn_ts: i64,
    pub mint_ts: i64,
    pub burn_proof: [u8; 32],
    pub mint_proof: [u8; 32],
    pub is_remote: bool,
    pub remote_ack: bool,
}

impl GhostAccount {
    pub fn space() -> usize {
        32 + 32 + 32 + 32 + 8 + 64 + 1 + 8 + 8 + 8 + 8 + 32 + 32 + 1 + 1
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIQUIDITY POOL STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

/// Liquidity pool state - holds SOL for instant cross-chain payments
#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct LiquidityPool {
    pub seed: [u8; 32],           // Pool identifier
    pub total_deposited: u64,      // Total SOL in pool
    pub total_shares: u64,         // Total LP shares issued
    pub total_fees: u64,           // Accumulated fees
    pub available_liquidity: u64,  // Currently available
    pub active: bool,              // Pool accepting deposits
}

impl LiquidityPool {
    pub fn space() -> usize {
        32 + 8 + 8 + 8 + 8 + 1
    }
}

/// LP position - tracks individual LP's stake
#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct LPPosition {
    pub owner: Pubkey,             // LP's wallet
    pub pool: [u8; 32],            // Which pool
    pub shares: u64,               // LP's share count
    pub deposited_at: i64,         // Timestamp
}

impl LPPosition {
    pub fn space() -> usize {
        32 + 32 + 8 + 8
    }
}

/// Payment intent received from another chain
#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct PaymentIntent {
    pub intent_id: [u8; 32],       // Unique ID
    pub sender_chain: u64,         // Source chain ID
    pub sender_address: [u8; 64],  // Sender on source chain
    pub amount: u64,               // Amount to deliver
    pub dest_token: Pubkey,        // Token to send
    pub recipient: Pubkey,         // Recipient on Solana
    pub executed: bool,            // Has been paid out
    pub timestamp: i64,            // When received
}

impl PaymentIntent {
    pub fn space() -> usize {
        32 + 8 + 64 + 8 + 32 + 32 + 1 + 8
    }
}

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction: GhostInstruction,
    ) -> ProgramResult {
        match instruction {
            GhostInstruction::Initialize {
                admin,
                validator_threshold,
                max_validators,
            } => Self::initialize(program_id, accounts, admin, validator_threshold, max_validators),
            GhostInstruction::SetValidator { validator, enabled } => {
                Self::set_validator(program_id, accounts, validator, enabled)
            }
            GhostInstruction::CreateGhost {
                ghost_id,
                amount,
                destination_chain,
                destination_address,
                source_token,
                destination_token,
            } => Self::create_ghost(
                program_id,
                accounts,
                ghost_id,
                amount,
                destination_chain,
                destination_address,
                source_token,
                destination_token,
            ),
            GhostInstruction::LockGhost { ghost_id } => {
                Self::lock_ghost(program_id, accounts, ghost_id)
            }
            GhostInstruction::BurnGhost {
                ghost_id,
                burn_proof,
            } => Self::burn_ghost(program_id, accounts, ghost_id, burn_proof),
            GhostInstruction::MirrorGhost {
                ghost_id,
                source_chain,
                amount,
                burn_proof,
                source_token,
                destination_token,
            } => Self::mirror_ghost(
                program_id,
                accounts,
                ghost_id,
                source_chain,
                amount,
                burn_proof,
                source_token,
                destination_token,
            ),
            GhostInstruction::MintGhost {
                ghost_id,
                mint_proof,
                recipient,
            } => Self::mint_ghost(program_id, accounts, ghost_id, mint_proof, recipient),
            GhostInstruction::AcknowledgeRemote { ghost_id } => {
                Self::ack_remote(program_id, accounts, ghost_id)
            }
            GhostInstruction::DestroyGhost { ghost_id } => {
                Self::destroy_ghost(program_id, accounts, ghost_id)
            }
            // Pool instructions
            GhostInstruction::InitializePool { pool_seed } => {
                Self::initialize_pool(program_id, accounts, pool_seed)
            }
            GhostInstruction::DepositToPool { amount } => {
                Self::deposit_to_pool(program_id, accounts, amount)
            }
            GhostInstruction::WithdrawFromPool { shares } => {
                Self::withdraw_from_pool(program_id, accounts, shares)
            }
            GhostInstruction::ExecutePayment { intent_id, recipient, amount } => {
                Self::execute_payment(program_id, accounts, intent_id, recipient, amount)
            }
            GhostInstruction::RecordPaymentIntent { intent_id, sender_chain, sender_address, amount, dest_token } => {
                Self::record_payment_intent(program_id, accounts, intent_id, sender_chain, sender_address, amount, dest_token)
            }
        }
    }

    fn initialize(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        admin: Pubkey,
        validator_threshold: u8,
        max_validators: u8,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_account = next_account_info(account_info_iter)?;
        let signer = next_account_info(account_info_iter)?;
        
        if !signer.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if config_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }

        let config = ProgramConfig {
            admin,
            validator_threshold,
            max_validators,
            validators: vec![],
        };

        config
            .serialize(&mut &mut config_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        msg!("Ghost program initialized");
        Ok(())
    }

    fn load_config(
        program_id: &Pubkey,
        account: &AccountInfo,
    ) -> Result<ProgramConfig, ProgramError> {
        if account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }
        // Use deserialize with a reader to handle accounts with extra space
        let data = account.data.borrow();
        let mut slice: &[u8] = &data;
        ProgramConfig::deserialize(&mut slice).map_err(|e| {
            msg!("Failed to deserialize config: {:?}", e);
            GhostError::AccountDeserialization.into()
        })
    }

    fn save_config(account: &AccountInfo, config: &ProgramConfig) -> ProgramResult {
        config
            .serialize(&mut &mut account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;
        Ok(())
    }

    fn ensure_admin(config: &ProgramConfig, signer: &AccountInfo) -> ProgramResult {
        if !signer.is_signer || signer.key != &config.admin {
            return Err(GhostError::UnauthorizedAdmin.into());
        }
        Ok(())
    }

    fn set_validator(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        validator: Pubkey,
        enabled: bool,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_account = next_account_info(account_info_iter)?;
        let admin = next_account_info(account_info_iter)?;

        let mut config = Self::load_config(program_id, config_account)?;
        Self::ensure_admin(&config, admin)?;

        if enabled {
            if !config.validators.iter().any(|v| v == &validator) {
                if config.validators.len() >= config.max_validators as usize {
                    return Err(GhostError::ValidatorLimit.into());
                }
                config.validators.push(validator);
            }
        } else {
            config.validators.retain(|v| v != &validator);
        }

        Self::save_config(config_account, &config)?;
        msg!("Validator updated");
        Ok(())
    }

    fn create_ghost(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ghost_id: [u8; 32],
        amount: u64,
        destination_chain: u64,
        destination_address: [u8; 64],
        source_token: Pubkey,
        destination_token: Pubkey,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_account = next_account_info(account_info_iter)?;
        let ghost_account = next_account_info(account_info_iter)?;
        let payer = next_account_info(account_info_iter)?;

        let _config = Self::load_config(program_id, config_account)?;
        if !payer.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if ghost_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }

        let ghost = GhostAccount {
            ghost_id,
            initiator: *payer.key,
            source_token,
            destination_token,
            destination_chain,
            destination_address,
            state: GhostState::Created,
            amount,
            lock_ts: Clock::get()?.unix_timestamp,
            burn_ts: 0,
            mint_ts: 0,
            burn_proof: [0u8; 32],
            mint_proof: [0u8; 32],
            is_remote: false,
            remote_ack: false,
        };

        ghost
            .serialize(&mut &mut ghost_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        msg!("Ghost created");
        Ok(())
    }

    fn lock_ghost(program_id: &Pubkey, accounts: &[AccountInfo], ghost_id: [u8; 32]) -> ProgramResult {
        let (config, mut ghost) = Self::load_with_validator(program_id, accounts, ghost_id)?;
        if ghost.state != GhostState::Created {
            return Err(GhostError::InvalidState.into());
        }
        ghost.state = GhostState::Locked;
        ghost.lock_ts = Clock::get()?.unix_timestamp;
        Self::write_ghost(accounts, ghost)?;
        let _ = config;
        msg!("Ghost locked");
        Ok(())
    }

    fn burn_ghost(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ghost_id: [u8; 32],
        burn_proof: [u8; 32],
    ) -> ProgramResult {
        let (config, mut ghost) = Self::load_with_validator(program_id, accounts, ghost_id)?;
        if ghost.state != GhostState::Locked {
            return Err(GhostError::InvalidState.into());
        }
        ghost.state = GhostState::Burned;
        ghost.burn_ts = Clock::get()?.unix_timestamp;
        ghost.burn_proof = burn_proof;
        Self::write_ghost(accounts, ghost)?;
        let _ = config;
        msg!("Ghost burned");
        Ok(())
    }

    fn mirror_ghost(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ghost_id: [u8; 32],
        source_chain: u64,
        amount: u64,
        burn_proof: [u8; 32],
        source_token: Pubkey,
        destination_token: Pubkey,
    ) -> ProgramResult {
        let (config, mut ghost) = Self::load_with_validator(program_id, accounts, ghost_id)?;
        if ghost.state != GhostState::None && !ghost.is_remote {
            return Err(GhostError::GhostExists.into());
        }

        ghost.ghost_id = ghost_id;
        ghost.initiator = Pubkey::default();
        ghost.source_token = source_token;
        ghost.destination_token = destination_token;
        ghost.destination_chain = source_chain;
        ghost.state = GhostState::Burned;
        ghost.amount = amount;
        ghost.burn_ts = Clock::get()?.unix_timestamp;
        ghost.burn_proof = burn_proof;
        ghost.is_remote = true;

        Self::write_ghost(accounts, ghost)?;
        let _ = config;
        msg!("Ghost mirrored from remote chain");
        Ok(())
    }

    fn mint_ghost(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ghost_id: [u8; 32],
        mint_proof: [u8; 32],
        recipient: Pubkey,
    ) -> ProgramResult {
        let (config, mut ghost) = Self::load_with_validator(program_id, accounts, ghost_id)?;
        if ghost.state != GhostState::Burned {
            return Err(GhostError::InvalidState.into());
        }
        ghost.state = GhostState::Minted;
        ghost.mint_ts = Clock::get()?.unix_timestamp;
        ghost.mint_proof = mint_proof;
        ghost.destination_address[..32].copy_from_slice(&recipient.to_bytes());

        Self::write_ghost(accounts, ghost)?;
        let _ = config;
        msg!("Ghost minted");
        Ok(())
    }

    fn ack_remote(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ghost_id: [u8; 32],
    ) -> ProgramResult {
        let (config, mut ghost) = Self::load_with_validator(program_id, accounts, ghost_id)?;
        if ghost.state != GhostState::Burned {
            return Err(GhostError::InvalidState.into());
        }
        ghost.remote_ack = true;
        Self::write_ghost(accounts, ghost)?;
        let _ = config;
        msg!("Remote mint acknowledged");
        Ok(())
    }

    fn destroy_ghost(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ghost_id: [u8; 32],
    ) -> ProgramResult {
        let (config, mut ghost) = Self::load_with_validator(program_id, accounts, ghost_id)?;
        if ghost.state != GhostState::Minted && !ghost.remote_ack {
            return Err(GhostError::InvalidState.into());
        }
        ghost.state = GhostState::Settled;
        Self::write_ghost(accounts, ghost)?;
        let _ = config;
        msg!("Ghost destroyed/settled");
        Ok(())
    }

    fn load_with_validator(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ghost_id: [u8; 32],
    ) -> Result<(ProgramConfig, GhostAccount), ProgramError> {
        let account_info_iter = &mut accounts.iter();
        let config_account = next_account_info(account_info_iter)?;
        let ghost_account = next_account_info(account_info_iter)?;
        let validator = next_account_info(account_info_iter)?;

        let config = Self::load_config(program_id, config_account)?;
        config.assert_validator(validator.key)?;
        if !validator.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if ghost_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }
        
        let ghost: GhostAccount = GhostAccount::try_from_slice(&ghost_account.data.borrow())
            .unwrap_or(GhostAccount {
                ghost_id: [0u8; 32],
                initiator: Pubkey::default(),
                source_token: Pubkey::default(),
                destination_token: Pubkey::default(),
                destination_chain: 0,
                destination_address: [0u8; 64],
                state: GhostState::None,
                amount: 0,
                lock_ts: 0,
                burn_ts: 0,
                mint_ts: 0,
                burn_proof: [0u8; 32],
                mint_proof: [0u8; 32],
                is_remote: false,
                remote_ack: false,
            });

        if ghost.ghost_id != ghost_id && ghost.state != GhostState::None {
            return Err(GhostError::GhostMismatch.into());
        }

        Ok((config, ghost))
    }

    fn write_ghost(accounts: &[AccountInfo], ghost: GhostAccount) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let _config_account = next_account_info(account_info_iter)?;
        let ghost_account = next_account_info(account_info_iter)?;
        let _validator = next_account_info(account_info_iter)?;

        ghost
            .serialize(&mut &mut ghost_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // LIQUIDITY POOL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// Initialize a new liquidity pool
    fn initialize_pool(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        pool_seed: [u8; 32],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let pool_account = next_account_info(account_info_iter)?;
        let authority = next_account_info(account_info_iter)?;

        if !authority.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if pool_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }

        let pool = LiquidityPool {
            seed: pool_seed,
            total_deposited: 0,
            total_shares: 0,
            total_fees: 0,
            available_liquidity: 0,
            active: true,
        };

        pool.serialize(&mut &mut pool_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        msg!("Liquidity pool initialized");
        Ok(())
    }

    /// Deposit SOL into the pool
    fn deposit_to_pool(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        amount: u64,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let pool_account = next_account_info(account_info_iter)?;
        let lp_position_account = next_account_info(account_info_iter)?;
        let depositor = next_account_info(account_info_iter)?;
        let system_program = next_account_info(account_info_iter)?;

        if !depositor.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if pool_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }

        // Load pool
        let mut pool: LiquidityPool = LiquidityPool::try_from_slice(&pool_account.data.borrow())
            .map_err(|_| GhostError::AccountDeserialization)?;

        if !pool.active {
            msg!("Pool not active");
            return Err(ProgramError::InvalidAccountData);
        }

        // Calculate shares
        let shares = if pool.total_shares == 0 {
            amount
        } else {
            (amount as u128 * pool.total_shares as u128 / pool.total_deposited as u128) as u64
        };

        // Transfer SOL from depositor to pool
        let transfer_ix = solana_program::system_instruction::transfer(
            depositor.key,
            pool_account.key,
            amount,
        );
        solana_program::program::invoke(
            &transfer_ix,
            &[depositor.clone(), pool_account.clone(), system_program.clone()],
        )?;

        // Update pool
        pool.total_deposited += amount;
        pool.total_shares += shares;
        pool.available_liquidity += amount;

        pool.serialize(&mut &mut pool_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        // Update LP position
        let mut position: LPPosition = LPPosition::try_from_slice(&lp_position_account.data.borrow())
            .unwrap_or(LPPosition {
                owner: *depositor.key,
                pool: pool.seed,
                shares: 0,
                deposited_at: 0,
            });

        position.shares += shares;
        position.deposited_at = Clock::get()?.unix_timestamp;

        position.serialize(&mut &mut lp_position_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        msg!("Deposited {} lamports, received {} shares", amount, shares);
        Ok(())
    }

    /// Withdraw SOL from the pool
    fn withdraw_from_pool(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        shares: u64,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let pool_account = next_account_info(account_info_iter)?;
        let lp_position_account = next_account_info(account_info_iter)?;
        let withdrawer = next_account_info(account_info_iter)?;

        if !withdrawer.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if pool_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }

        // Load pool
        let mut pool: LiquidityPool = LiquidityPool::try_from_slice(&pool_account.data.borrow())
            .map_err(|_| GhostError::AccountDeserialization)?;

        // Load position
        let mut position: LPPosition = LPPosition::try_from_slice(&lp_position_account.data.borrow())
            .map_err(|_| GhostError::AccountDeserialization)?;

        if position.owner != *withdrawer.key {
            msg!("Not position owner");
            return Err(ProgramError::InvalidAccountData);
        }
        if position.shares < shares {
            msg!("Insufficient shares");
            return Err(ProgramError::InsufficientFunds);
        }

        // Calculate withdrawal amount (includes earned fees)
        let amount = (shares as u128 * pool.total_deposited as u128 / pool.total_shares as u128) as u64;

        if pool.available_liquidity < amount {
            msg!("Insufficient pool liquidity");
            return Err(ProgramError::InsufficientFunds);
        }

        // Transfer SOL from pool to withdrawer
        **pool_account.try_borrow_mut_lamports()? -= amount;
        **withdrawer.try_borrow_mut_lamports()? += amount;

        // Update pool
        pool.total_deposited -= amount;
        pool.total_shares -= shares;
        pool.available_liquidity -= amount;

        pool.serialize(&mut &mut pool_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        // Update position
        position.shares -= shares;

        position.serialize(&mut &mut lp_position_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        msg!("Withdrew {} lamports for {} shares", amount, shares);
        Ok(())
    }

    /// Execute a cross-chain payment (sends SOL from pool to recipient)
    fn execute_payment(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        intent_id: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_account = next_account_info(account_info_iter)?;
        let pool_account = next_account_info(account_info_iter)?;
        let recipient_account = next_account_info(account_info_iter)?;
        let relayer = next_account_info(account_info_iter)?;

        // Verify relayer is authorized
        let config = Self::load_config(program_id, config_account)?;
        config.assert_validator(relayer.key)?;

        if !relayer.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if pool_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }
        if *recipient_account.key != recipient {
            msg!("Recipient mismatch");
            return Err(ProgramError::InvalidAccountData);
        }

        // Load pool
        let mut pool: LiquidityPool = LiquidityPool::try_from_slice(&pool_account.data.borrow())
            .map_err(|_| GhostError::AccountDeserialization)?;

        if pool.available_liquidity < amount {
            msg!("Insufficient pool liquidity: {} < {}", pool.available_liquidity, amount);
            return Err(ProgramError::InsufficientFunds);
        }

        // Transfer SOL from pool to recipient
        **pool_account.try_borrow_mut_lamports()? -= amount;
        **recipient_account.try_borrow_mut_lamports()? += amount;

        // Update pool
        pool.available_liquidity -= amount;

        pool.serialize(&mut &mut pool_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        msg!("Payment executed: {} lamports to {} (intent: {:?})", 
            amount, recipient, &intent_id[..8]);
        Ok(())
    }

    /// Record an incoming payment intent from another chain
    fn record_payment_intent(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        intent_id: [u8; 32],
        sender_chain: u64,
        sender_address: [u8; 64],
        amount: u64,
        dest_token: Pubkey,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_account = next_account_info(account_info_iter)?;
        let intent_account = next_account_info(account_info_iter)?;
        let relayer = next_account_info(account_info_iter)?;

        // Verify relayer is authorized
        let config = Self::load_config(program_id, config_account)?;
        config.assert_validator(relayer.key)?;

        if !relayer.is_signer {
            return Err(GhostError::MissingSigner.into());
        }
        if intent_account.owner != program_id {
            return Err(GhostError::IncorrectProgramId.into());
        }

        let intent = PaymentIntent {
            intent_id,
            sender_chain,
            sender_address,
            amount,
            dest_token,
            recipient: Pubkey::default(), // Set when executed
            executed: false,
            timestamp: Clock::get()?.unix_timestamp,
        };

        intent.serialize(&mut &mut intent_account.data.borrow_mut()[..])
            .map_err(|_| GhostError::AccountSerialization)?;

        msg!("Payment intent recorded: {:?}", &intent_id[..8]);
        Ok(())
    }
}

#[derive(Debug, Copy, Clone)]
pub enum GhostError {
    InvalidInstruction,
    AccountSerialization,
    AccountDeserialization,
    UnauthorizedAdmin,
    ValidatorExists,
    ValidatorLimit,
    MissingSigner,
    UnauthorizedValidator,
    IncorrectProgramId,
    GhostExists,
    GhostMismatch,
    InvalidState,
}

impl From<GhostError> for ProgramError {
    fn from(value: GhostError) -> Self {
        ProgramError::Custom(value as u32)
    }
}
