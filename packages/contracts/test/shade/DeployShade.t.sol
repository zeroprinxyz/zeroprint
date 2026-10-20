// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IAccessControl} from '@oz/access/IAccessControl.sol';
import {IERC20} from '@oz/token/ERC20/ERC20.sol';
import {Test} from 'forge-std/Test.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolSimple} from 'contracts/implementations/PrivacyPoolSimple.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {DeployShade} from '../../script/DeployShade.s.sol';

contract ShadeDeployTest is Test {
  bytes32 internal constant _OWNER_ROLE = keccak256('OWNER_ROLE');
  bytes32 internal constant _ASP_POSTMAN = keccak256('ASP_POSTMAN');

  address internal _postman = makeAddr('postman');
  address internal _deployer;
  Entrypoint internal _entrypoint;
  PrivacyPoolSimple internal _pool;

  function setUp() public {
    vm.setEnv('POSTMAN_ADDRESS', vm.toString(_postman));
    vm.setEnv('RENOUNCE', 'true');
    DeployShade _script = new DeployShade();
    (_entrypoint, _pool) = _script.run();
    (, _deployer,) = vm.readCallers();
  }

  function test_PoolRegisteredWithZeroVettingFee() public view {
    (IPrivacyPool _p, uint256 _min, uint256 _vetting, uint256 _maxRelay) =
      _entrypoint.assetConfig(IERC20(Constants.NATIVE_ASSET));
    assertEq(address(_p), address(_pool));
    assertEq(_min, 0.001 ether);
    assertEq(_vetting, 0);
    assertEq(_maxRelay, 50);
  }

  function test_NobodyHoldsOwnerRole() public view {
    assertFalse(_entrypoint.hasRole(_OWNER_ROLE, _deployer));
    assertFalse(_entrypoint.hasRole(_OWNER_ROLE, _postman));
    assertTrue(_entrypoint.hasRole(_ASP_POSTMAN, _postman));
  }

  function test_AdminCallsRevertAfterRenounce() public {
    address _newImpl = address(new Entrypoint());
    vm.startPrank(_deployer);

    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _deployer, _OWNER_ROLE)
    );
    _entrypoint.upgradeToAndCall(_newImpl, '');

    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _deployer, _OWNER_ROLE)
    );
    _entrypoint.windDownPool(IPrivacyPool(address(_pool)));

    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _deployer, _OWNER_ROLE)
    );
    _entrypoint.removePool(IERC20(Constants.NATIVE_ASSET));

    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _deployer, _OWNER_ROLE)
    );
    _entrypoint.withdrawFees(IERC20(Constants.NATIVE_ASSET), _deployer);

    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _deployer, _OWNER_ROLE)
    );
    _entrypoint.grantRole(_OWNER_ROLE, _deployer);

    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _deployer, _OWNER_ROLE)
    );
    _entrypoint.updatePoolConfiguration(IERC20(Constants.NATIVE_ASSET), 0, 0, 10_000);

    vm.stopPrank();
  }

  function test_PostmanCannotGrantOwner() public {
    vm.prank(_postman);
    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, _postman, _OWNER_ROLE)
    );
    _entrypoint.grantRole(_OWNER_ROLE, _postman);
  }

  function test_PostmanCanPublishRoot() public {
    vm.prank(_postman);
    _entrypoint.updateRoot(123, 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy');
    assertEq(_entrypoint.latestRoot(), 123);
  }

  function test_DepositFullAmountReachesPool() public {
    address _alice = makeAddr('alice');
    vm.deal(_alice, 1 ether);
    vm.prank(_alice);
    _entrypoint.deposit{value: 0.1 ether}(uint256(keccak256('pre')) % Constants.SNARK_SCALAR_FIELD);
    assertEq(address(_pool).balance, 0.1 ether);
    assertEq(address(_entrypoint).balance, 0);
  }
}
