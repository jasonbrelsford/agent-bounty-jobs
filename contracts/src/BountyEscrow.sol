// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BountyEscrow
 * @notice Escrow for one job at a time between a poster and the agent who took it.
 *
 *  1. When an agent accepts a job, the poster locks the reward here, naming that
 *     agent. The agent can now see on-chain that the money exists.
 *  2. The agent does the work and calls submit() with a hash of the deliverable.
 *  3. The poster checks it and calls complete(): the agent is paid the reward
 *     minus the fee, and the fee goes to the treasury.
 *     The poster can instead call reject() within the review window, which
 *     refunds the poster in full.
 *     If the poster does neither within REVIEW_WINDOW of the submission, anyone
 *     can call complete() and the agent is paid, so a poster cannot stall forever.
 *  4. If the deadline passes with no submission, or the agent gives the job up,
 *     the poster gets everything back. No fee is ever taken on a refund.
 *
 * Rules that make it hard to steal from:
 *  - No owner, admin, upgrade, pause or rescue function. Every setting is fixed
 *    in the constructor. Money can only ever go to a job's poster or its agent
 *    (and the fee to the fixed treasury), and only by the rules above.
 *  - One token, fixed at deploy (Circle's USDC on the target chain).
 *  - The website holds no key and has no role here. Nothing anyone writes in a
 *    job, a submission or a message can move money; only these calls can.
 *  - Launch limits: a cap per job, a cap on how many jobs can be open at once,
 *    and a cap on the total held, so the most anyone could ever take from a bug
 *    is small. Raising them means deploying a new contract.
 *  - Payouts are pushed; if a transfer is refused (for example Circle froze that
 *    address), the amount is credited for that address to withdraw later, so one
 *    blocked party never traps anyone else's money.
 */
contract BountyEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Funded, // money locked, agent working
        Submitted, // agent delivered, poster reviewing
        Paid,
        Refunded
    }

    struct Job {
        address poster;
        uint96 amount;
        address agent;
        uint40 deadline; // last moment the agent may submit
        uint40 submittedAt;
        State state;
        bytes32 deliverable; // hash of the delivered work
    }

    uint256 public constant MAX_FEE_BPS = 1_000; // the constructor refuses more than 10%
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant REVIEW_WINDOW = 3 days;

    IERC20 public immutable token;
    address public immutable treasury;
    uint256 public immutable feeBps;
    uint256 public immutable minAmount;
    uint256 public immutable maxAmount; // per job
    uint256 public immutable maxOpenJobs;
    uint256 public immutable maxHeld; // total locked in open jobs

    uint256 public nextId = 1;
    uint256 public openJobs;
    uint256 public held; // locked in open jobs
    mapping(uint256 => Job) public jobs;
    /// Payouts whose transfer was refused, claimable by that address.
    mapping(address => uint256) public credit;
    uint256 public totalCredit;

    event Funded(uint256 indexed id, address indexed poster, address indexed agent, uint256 amount, uint256 deadline, bytes32 ref);
    event Submitted(uint256 indexed id, bytes32 deliverable);
    event Paid(uint256 indexed id, address indexed agent, uint256 toAgent, uint256 fee);
    event Refunded(uint256 indexed id, address indexed poster, uint256 amount, uint8 reason); // 0 rejected, 1 expired, 2 agent gave up
    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error BadConfig();
    error BadAmount();
    error BadDeadline();
    error BadAgent();
    error TooManyOpenJobs();
    error TooMuchHeld();
    error WrongState();
    error NotPoster();
    error NotAgent();
    error TooEarly();
    error TooLate();
    error ReceivedWrongAmount();
    error NothingToWithdraw();

    constructor(
        IERC20 token_,
        address treasury_,
        uint256 feeBps_,
        uint256 minAmount_,
        uint256 maxAmount_,
        uint256 maxOpenJobs_,
        uint256 maxHeld_
    ) {
        if (
            address(token_).code.length == 0 || treasury_ == address(0) || treasury_ == address(token_)
                || feeBps_ > MAX_FEE_BPS || minAmount_ == 0 || minAmount_ > maxAmount_ || maxAmount_ > maxHeld_
                || maxHeld_ > type(uint96).max || maxOpenJobs_ == 0
        ) revert BadConfig();
        token = token_;
        treasury = treasury_;
        feeBps = feeBps_;
        minAmount = minAmount_;
        maxAmount = maxAmount_;
        maxOpenJobs = maxOpenJobs_;
        maxHeld = maxHeld_;
    }

    // ── Poster ────────────────────────────────────────────────────────────

    /**
     * @notice Lock `amount` for `agent`, who has accepted the job. The caller is the poster.
     *         Approve exactly `amount` to this contract first; never approve more.
     * @param deadline last moment the agent may submit; after it the poster can reclaim
     * @param ref the board's job id (hashed), so the board can match this deposit
     */
    function fund(address agent, uint256 amount, uint256 deadline, bytes32 ref)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (amount < minAmount || amount > maxAmount) revert BadAmount();
        if (deadline < block.timestamp + MIN_DURATION || deadline > block.timestamp + MAX_DURATION) revert BadDeadline();
        if (agent == address(0) || agent == msg.sender || agent == address(this) || agent == address(token) || agent == treasury) {
            revert BadAgent();
        }
        if (openJobs >= maxOpenJobs) revert TooManyOpenJobs();
        if (held + amount > maxHeld) revert TooMuchHeld();

        id = nextId++;
        jobs[id] = Job({
            poster: msg.sender,
            amount: uint96(amount),
            agent: agent,
            deadline: uint40(deadline),
            submittedAt: 0,
            state: State.Funded,
            deliverable: bytes32(0)
        });
        openJobs += 1;
        held += amount;

        // Exact-receipt check: rejects any token that delivers less than asked.
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert ReceivedWrongAmount();

        emit Funded(id, msg.sender, agent, amount, deadline, ref);
    }

    /// @notice Poster turns the work down during review. Full refund to the poster.
    function reject(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Submitted) revert WrongState();
        if (msg.sender != j.poster) revert NotPoster();
        if (block.timestamp > uint256(j.submittedAt) + REVIEW_WINDOW) revert TooLate();
        _refund(id, j, 0);
    }

    // ── Agent ─────────────────────────────────────────────────────────────

    /// @notice Agent delivers, by the deadline, with a hash of the work.
    function submit(uint256 id, bytes32 deliverable) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Funded) revert WrongState();
        if (msg.sender != j.agent) revert NotAgent();
        if (block.timestamp > j.deadline) revert TooLate();
        if (deliverable == bytes32(0)) revert WrongState();
        j.state = State.Submitted;
        j.submittedAt = uint40(block.timestamp);
        j.deliverable = deliverable;
        emit Submitted(id, deliverable);
    }

    /// @notice Agent gives the job up before submitting. Full refund to the poster.
    function abandon(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Funded) revert WrongState();
        if (msg.sender != j.agent) revert NotAgent();
        _refund(id, j, 2);
    }

    // ── Anyone (the outcome is fixed; only who pays gas changes) ─────────

    /**
     * @notice Pay the agent for submitted work. The poster may call it at once;
     *         anyone may call it once the review window has passed with no answer.
     */
    function complete(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Submitted) revert WrongState();
        if (msg.sender != j.poster && block.timestamp <= uint256(j.submittedAt) + REVIEW_WINDOW) revert TooEarly();

        uint256 amount = j.amount;
        uint256 fee = (amount * feeBps) / 10_000;
        address agent = j.agent;
        j.state = State.Paid;
        openJobs -= 1;
        held -= amount;

        _pay(agent, amount - fee);
        if (fee != 0) _pay(treasury, fee);
        emit Paid(id, agent, amount - fee, fee);
    }

    /// @notice After the deadline with no submission, return the money to the poster.
    function refundExpired(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Funded) revert WrongState();
        if (block.timestamp <= j.deadline) revert TooEarly();
        _refund(id, j, 1);
    }

    /// @notice Claim payouts whose transfer was refused earlier. Pays only the caller.
    function withdraw() external nonReentrant {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        totalCredit -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ── Internal ──────────────────────────────────────────────────────────

    function _refund(uint256 id, Job storage j, uint8 reason) private {
        uint256 amount = j.amount;
        address poster = j.poster;
        j.state = State.Refunded;
        openJobs -= 1;
        held -= amount;
        _pay(poster, amount);
        emit Refunded(id, poster, amount, reason);
    }

    /// Push a payment; if the token refuses it, keep it as credit for that address.
    function _pay(address to, uint256 amount) private {
        // Checked by hand instead of safeTransfer, so one refused transfer
        // cannot block the rest of the payout.
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && (data.length != 32 || abi.decode(data, (uint256)) != 1))) {
            credit[to] += amount;
            totalCredit += amount;
            emit Credited(to, amount);
        }
    }
}
