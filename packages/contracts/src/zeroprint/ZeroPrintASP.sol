// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {InternalLeanIMT, LeanIMTData} from 'lean-imt/InternalLeanIMT.sol';

interface IEntrypointRoots {
  function updateRoot(uint256 _root, string memory _ipfsCID) external returns (uint256 _index);
}

interface IPoolDepositors {
  function depositors(uint256 _label) external view returns (address _depositor);
}

/**
 * @title ZeroPrint ASP
 * @notice The association set provider as a contract, so private withdrawals keep working without
 *         the team. It is the Entrypoint's ASP_POSTMAN; no key can post roots.
 *
 *         1. queue(label)      anyone, once the deposit exists in the pool. Starts the window.
 *         2. deny(label, why)  the guardian only, and only before the window ends. A denied deposit
 *                              can still ragequit back to its depositor.
 *         3. approve(labels)   anyone, once the window has passed. Adds the labels to the on-chain
 *                              set (LeanIMT, Poseidon, as the withdraw circuit expects) and posts
 *                              the set's root to the Entrypoint.
 *
 *         Without a guardian (renounced, or simply gone) every queued deposit is approved once its
 *         window has passed. The set only grows: an approval cannot be taken back.
 */
contract ZeroPrintASP {
  using InternalLeanIMT for LeanIMTData;

  IEntrypointRoots public immutable ENTRYPOINT;
  IPoolDepositors public immutable POOL;
  /// @notice Seconds a queued deposit waits before it can be approved
  uint256 public immutable WINDOW;

  /// @notice May deny deposits inside their window; address(0) once renounced
  address public guardian;

  /// @notice label => time it was queued (0: not queued)
  mapping(uint256 _label => uint256 _at) public queuedAt;
  /// @notice label => denied by the guardian
  mapping(uint256 _label => bool _denied) public denied;

  LeanIMTData internal _set;

  event Queued(uint256 indexed _label, address indexed _depositor, uint256 _at);
  event Denied(uint256 indexed _label, string _reason);
  event Approved(uint256 indexed _label, uint256 _index);
  event RootPosted(uint256 _root, uint256 _size);
  event GuardianChanged(address indexed _from, address indexed _to);

  error UnknownDeposit();
  error AlreadyQueued();
  error WindowClosed();
  error AlreadyApproved();
  error NothingToApprove();
  error NotGuardian();

  enum Status {
    None,
    Waiting,
    Ready,
    Approved,
    Denied
  }

  modifier onlyGuardian() {
    if (msg.sender != guardian || guardian == address(0)) revert NotGuardian();
    _;
  }

  constructor(IEntrypointRoots _entrypoint, IPoolDepositors _pool, uint256 _window, address _guardian) {
    ENTRYPOINT = _entrypoint;
    POOL = _pool;
    WINDOW = _window;
    guardian = _guardian;
    emit GuardianChanged(address(0), _guardian);
  }

  /*///////////////////////////////////////////////////////////////
                              QUEUE
  //////////////////////////////////////////////////////////////*/

  /// @notice Start the window for a deposit. Anyone can call it.
  function queue(uint256 _label) public {
    address _depositor = POOL.depositors(_label);
    if (_depositor == address(0)) revert UnknownDeposit();
    if (queuedAt[_label] != 0) revert AlreadyQueued();
    queuedAt[_label] = block.timestamp;
    emit Queued(_label, _depositor, block.timestamp);
  }

  /// @notice Queue several deposits; ones already queued or unknown are skipped.
  function queueMany(uint256[] calldata _labels) external {
    for (uint256 _i; _i < _labels.length; ++_i) {
      uint256 _label = _labels[_i];
      if (queuedAt[_label] != 0) continue;
      address _depositor = POOL.depositors(_label);
      if (_depositor == address(0)) continue;
      queuedAt[_label] = block.timestamp;
      emit Queued(_label, _depositor, block.timestamp);
    }
  }

  /*///////////////////////////////////////////////////////////////
                              GUARDIAN
  //////////////////////////////////////////////////////////////*/

  /// @notice Deny a deposit before its window ends (queueing it first if needed).
  function deny(uint256 _label, string calldata _reason) external onlyGuardian {
    if (queuedAt[_label] == 0) queue(_label);
    if (block.timestamp >= queuedAt[_label] + WINDOW) revert WindowClosed();
    if (_set._has(_label)) revert AlreadyApproved();
    denied[_label] = true;
    emit Denied(_label, _reason);
  }

  /// @notice Hand the guardian role to another address (key rotation).
  function transferGuardian(address _to) external onlyGuardian {
    emit GuardianChanged(guardian, _to);
    guardian = _to;
  }

  /// @notice Give the role up for good: from then on, deposits are approved by the window alone.
  function renounceGuardian() external onlyGuardian {
    emit GuardianChanged(guardian, address(0));
    guardian = address(0);
  }

  /*///////////////////////////////////////////////////////////////
                              APPROVE
  //////////////////////////////////////////////////////////////*/

  /// @notice Approve every eligible label in the list (others are skipped) and post the new root.
  function approve(uint256[] calldata _labels) external returns (uint256 _root) {
    uint256 _added;
    for (uint256 _i; _i < _labels.length; ++_i) {
      uint256 _label = _labels[_i];
      if (status(_label) != Status.Ready) continue;
      _set._insert(_label);
      emit Approved(_label, _set.size - 1);
      ++_added;
    }
    if (_added == 0) revert NothingToApprove();
    _root = _set._root();
    ENTRYPOINT.updateRoot(_root, _cid(_root));
    emit RootPosted(_root, _set.size);
  }

  /*///////////////////////////////////////////////////////////////
                              VIEWS
  //////////////////////////////////////////////////////////////*/

  function status(uint256 _label) public view returns (Status) {
    if (_set._has(_label)) return Status.Approved;
    if (denied[_label]) return Status.Denied;
    uint256 _at = queuedAt[_label];
    if (_at == 0) return Status.None;
    return block.timestamp >= _at + WINDOW ? Status.Ready : Status.Waiting;
  }

  function root() external view returns (uint256) {
    return _set._root();
  }

  function size() external view returns (uint256) {
    return _set.size;
  }

  function depth() external view returns (uint256) {
    return _set.depth;
  }

  function isApproved(uint256 _label) external view returns (bool) {
    return _set._has(_label);
  }

  function indexOf(uint256 _label) external view returns (uint256) {
    return _set._indexOf(_label);
  }

  /// @dev The Entrypoint wants a 32-64 character "CID". The set lives on-chain, so the root's
  ///      64 hex digits stand in for it; clients rebuild the set from Approved events.
  function _cid(uint256 _r) internal pure returns (string memory) {
    bytes memory _hex = '0123456789abcdef';
    bytes memory _out = new bytes(64);
    for (uint256 _i; _i < 32; ++_i) {
      uint8 _b = uint8(_r >> (8 * (31 - _i)));
      _out[2 * _i] = _hex[_b >> 4];
      _out[2 * _i + 1] = _hex[_b & 0x0f];
    }
    return string(_out);
  }
}
