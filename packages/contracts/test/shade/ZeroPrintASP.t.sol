// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IAccessControl} from '@oz/access/IAccessControl.sol';
import {Test, Vm} from 'forge-std/Test.sol';
import {PoseidonT3} from 'poseidon/PoseidonT3.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolSimple} from 'contracts/implementations/PrivacyPoolSimple.sol';
import {Constants} from 'contracts/lib/Constants.sol';

import {DeployZeroPrint} from '../../script/DeployZeroPrint.s.sol';
import {ZeroPrintASP} from '../../src/zeroprint/ZeroPrintASP.sol';

contract ZeroPrintASPTest is Test {
  bytes32 internal constant _OWNER_ROLE = keccak256('OWNER_ROLE');
  bytes32 internal constant _ASP_POSTMAN = keccak256('ASP_POSTMAN');
  bytes32 internal constant _DEPOSITED = keccak256('Deposited(address,uint256,uint256,uint256,uint256)');

  address internal _guardian = makeAddr('guardian');
  address internal _alice = makeAddr('alice');
  address internal _bob = makeAddr('bob');
  address internal _anyone = makeAddr('anyone');
  address internal _deployer;

  Entrypoint internal _entrypoint;
  PrivacyPoolSimple internal _pool;
  ZeroPrintASP internal _asp;
  uint256 internal _window;

  function setUp() public {
    vm.setEnv('GUARDIAN_ADDRESS', vm.toString(_guardian));
    vm.setEnv('ASP_WINDOW', '1800');
    (_entrypoint, _pool, _asp) = new DeployZeroPrint().run();
    (, _deployer,) = vm.readCallers();
    _window = _asp.WINDOW();
    vm.deal(_alice, 10 ether);
    vm.deal(_bob, 10 ether);
  }

  function _deposit(address _who, uint256 _salt) internal returns (uint256 _label) {
    vm.recordLogs();
    vm.prank(_who);
    _entrypoint.deposit{value: 0.1 ether}(uint256(keccak256(abi.encode(_who, _salt))) % Constants.SNARK_SCALAR_FIELD);
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].topics[0] == _DEPOSITED && _logs[_i].emitter == address(_pool)) {
        (, _label,,) = abi.decode(_logs[_i].data, (uint256, uint256, uint256, uint256));
      }
    }
    require(_label != 0, 'no Deposited event');
  }

  function _one(uint256 _l) internal pure returns (uint256[] memory _a) {
    _a = new uint256[](1);
    _a[0] = _l;
  }

  // ---------- wiring ----------

  function test_AspIsTheOnlyPostman() public view {
    assertTrue(_entrypoint.hasRole(_ASP_POSTMAN, address(_asp)));
    assertFalse(_entrypoint.hasRole(_ASP_POSTMAN, _deployer));
    assertFalse(_entrypoint.hasRole(_OWNER_ROLE, _deployer));
    assertEq(_asp.guardian(), _guardian);
    assertEq(_window, 1800);
  }

  function test_NobodyElseCanPostRoots() public {
    vm.prank(_deployer);
    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _deployer, _ASP_POSTMAN)
    );
    _entrypoint.updateRoot(1, 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy');
    vm.prank(_guardian);
    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _guardian, _ASP_POSTMAN)
    );
    _entrypoint.updateRoot(1, 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy');
  }

  // ---------- queue / approve ----------

  function test_QueueRejectsUnknownLabel() public {
    vm.expectRevert(ZeroPrintASP.UnknownDeposit.selector);
    _asp.queue(12_345);
  }

  function test_ApproveWaitsForTheWindow() public {
    uint256 _l = _deposit(_alice, 1);
    _asp.queue(_l);
    assertEq(uint8(_asp.status(_l)), uint8(ZeroPrintASP.Status.Waiting));
    vm.expectRevert(ZeroPrintASP.NothingToApprove.selector);
    _asp.approve(_one(_l));
    vm.warp(block.timestamp + _window);
    assertEq(uint8(_asp.status(_l)), uint8(ZeroPrintASP.Status.Ready));
  }

  function test_AnyoneApprovesAfterTheWindowAndTheRootIsPosted() public {
    uint256 _a = _deposit(_alice, 1);
    uint256 _b = _deposit(_bob, 2);
    vm.prank(_anyone);
    _asp.queue(_a);
    vm.prank(_anyone);
    _asp.queue(_b);
    vm.warp(block.timestamp + _window);
    uint256[] memory _ls = new uint256[](2);
    _ls[0] = _a;
    _ls[1] = _b;
    vm.prank(_anyone);
    uint256 _root = _asp.approve(_ls);
    // LeanIMT of [a, b] is Poseidon(a, b): what the withdraw circuit checks
    assertEq(_root, PoseidonT3.hash([_a, _b]));
    assertEq(_entrypoint.latestRoot(), _root);
    assertEq(_asp.size(), 2);
    assertEq(_asp.indexOf(_b), 1);
    assertEq(uint8(_asp.status(_a)), uint8(ZeroPrintASP.Status.Approved));
  }

  function test_ApproveSkipsIneligibleAndDuplicates() public {
    uint256 _a = _deposit(_alice, 1);
    uint256 _b = _deposit(_bob, 2);
    _asp.queue(_a);
    vm.warp(block.timestamp + _window);
    _asp.queue(_b); // still waiting
    uint256[] memory _ls = new uint256[](3);
    _ls[0] = _a;
    _ls[1] = _b;
    _ls[2] = _a;
    _asp.approve(_ls);
    assertEq(_asp.size(), 1);
    assertTrue(_asp.isApproved(_a));
    assertFalse(_asp.isApproved(_b));
  }

  function test_QueueManySkipsKnownAndUnknown() public {
    uint256 _a = _deposit(_alice, 1);
    _asp.queue(_a);
    uint256[] memory _ls = new uint256[](2);
    _ls[0] = _a;
    _ls[1] = 999;
    _asp.queueMany(_ls);
    assertGt(_asp.queuedAt(_a), 0);
    assertEq(_asp.queuedAt(999), 0);
  }

  // ---------- guardian ----------

  function test_GuardianDeniesInsideTheWindow() public {
    uint256 _l = _deposit(_alice, 1);
    vm.prank(_guardian);
    _asp.deny(_l, 'OFAC sanctioned address'); // queues it too
    vm.warp(block.timestamp + _window * 10);
    assertEq(uint8(_asp.status(_l)), uint8(ZeroPrintASP.Status.Denied));
    vm.expectRevert(ZeroPrintASP.NothingToApprove.selector);
    _asp.approve(_one(_l));
  }

  function test_GuardianCannotDenyAfterTheWindow() public {
    uint256 _l = _deposit(_alice, 1);
    _asp.queue(_l);
    vm.warp(block.timestamp + _window);
    vm.prank(_guardian);
    vm.expectRevert(ZeroPrintASP.WindowClosed.selector);
    _asp.deny(_l, 'too late');
  }

  function test_OnlyGuardianDenies() public {
    uint256 _l = _deposit(_alice, 1);
    vm.prank(_anyone);
    vm.expectRevert(ZeroPrintASP.NotGuardian.selector);
    _asp.deny(_l, 'nope');
  }

  function test_WithoutGuardianEverythingIsApprovedAfterTheWindow() public {
    vm.prank(_guardian);
    _asp.renounceGuardian();
    assertEq(_asp.guardian(), address(0));
    uint256 _l = _deposit(_alice, 1);
    vm.prank(_guardian);
    vm.expectRevert(ZeroPrintASP.NotGuardian.selector);
    _asp.deny(_l, 'gone');
    _asp.queue(_l);
    vm.warp(block.timestamp + _window);
    _asp.approve(_one(_l));
    assertTrue(_asp.isApproved(_l));
  }

  function test_GuardianRotates() public {
    address _next = makeAddr('next');
    vm.prank(_guardian);
    _asp.transferGuardian(_next);
    uint256 _l = _deposit(_alice, 1);
    vm.prank(_guardian);
    vm.expectRevert(ZeroPrintASP.NotGuardian.selector);
    _asp.deny(_l, 'old');
    vm.prank(_next);
    _asp.deny(_l, 'new');
    assertTrue(_asp.denied(_l));
  }
}
