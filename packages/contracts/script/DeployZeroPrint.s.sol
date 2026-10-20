// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {IERC20} from '@oz/token/ERC20/ERC20.sol';
import {Script} from 'forge-std/Script.sol';
import {VmSafe} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolSimple} from 'contracts/implementations/PrivacyPoolSimple.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {CommitmentVerifier} from 'contracts/verifiers/CommitmentVerifier.sol';
import {WithdrawalVerifier} from 'contracts/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {IEntrypointRoots, IPoolDepositors, ZeroPrintASP} from '../src/zeroprint/ZeroPrintASP.sol';

/**
 * @title ZeroPrint deployment
 * @notice The unmodified 0xbow protocol with one native ETH pool, whose ASP is the ZeroPrintASP
 *         contract (no key can post roots), then OWNER_ROLE is renounced. Afterwards nobody can
 *         upgrade, change the pool, take fees or appoint another ASP.
 * @dev Env:
 *      GUARDIAN_ADDRESS  may deny deposits inside their window (required)
 *      ASP_WINDOW        seconds, default 1800
 *      MIN_DEPOSIT       wei, default 0.001 ether
 *      MAX_RELAY_FEE_BPS default 50 (0.5%)
 */
contract DeployZeroPrint is Script {
  bytes32 internal constant _OWNER_ROLE = keccak256('OWNER_ROLE');
  bytes32 internal constant _ASP_POSTMAN = keccak256('ASP_POSTMAN');

  function run() external returns (Entrypoint _entrypoint, PrivacyPoolSimple _pool, ZeroPrintASP _asp) {
    address _guardian = vm.envAddress('GUARDIAN_ADDRESS');
    uint256 _window = vm.envOr('ASP_WINDOW', uint256(1800));
    uint256 _minDeposit = vm.envOr('MIN_DEPOSIT', uint256(0.001 ether));
    uint256 _maxRelayFeeBPS = vm.envOr('MAX_RELAY_FEE_BPS', uint256(50));

    vm.startBroadcast();
    (, address _deployer,) = vm.readCallers();

    address _withdrawalVerifier = address(new WithdrawalVerifier());
    address _ragequitVerifier = address(new CommitmentVerifier());

    // initialize() needs a postman: the deployer holds the role for the few calls until the ASP exists
    address _impl = address(new Entrypoint());
    _entrypoint =
      Entrypoint(payable(new ERC1967Proxy(_impl, abi.encodeCall(Entrypoint.initialize, (_deployer, _deployer)))));

    _pool = new PrivacyPoolSimple(address(_entrypoint), _withdrawalVerifier, _ragequitVerifier);

    // Vetting fee 0: fees could only be pulled by OWNER, which is renounced below
    _entrypoint.registerPool(
      IERC20(Constants.NATIVE_ASSET), IPrivacyPool(address(_pool)), _minDeposit, 0, _maxRelayFeeBPS
    );

    _asp = new ZeroPrintASP(IEntrypointRoots(address(_entrypoint)), IPoolDepositors(address(_pool)), _window, _guardian);
    _entrypoint.grantRole(_ASP_POSTMAN, address(_asp));
    _entrypoint.revokeRole(_ASP_POSTMAN, _deployer);
    _entrypoint.renounceRole(_OWNER_ROLE, _deployer);
    vm.stopBroadcast();

    console.log('WithdrawalVerifier:', _withdrawalVerifier);
    console.log('CommitmentVerifier:', _ragequitVerifier);
    console.log('Entrypoint impl:   ', _impl);
    console.log('Entrypoint proxy:  ', address(_entrypoint));
    console.log('ETH pool:          ', address(_pool));
    console.log('ZeroPrint ASP:     ', address(_asp));
    console.log('Pool scope:        ', _pool.SCOPE());

    if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
      string memory _k = 'zp';
      vm.serializeUint(_k, 'chainId', block.chainid);
      vm.serializeUint(_k, 'startBlock', block.number);
      vm.serializeAddress(_k, 'withdrawalVerifier', _withdrawalVerifier);
      vm.serializeAddress(_k, 'ragequitVerifier', _ragequitVerifier);
      vm.serializeAddress(_k, 'entrypointImpl', _impl);
      vm.serializeAddress(_k, 'entrypoint', address(_entrypoint));
      vm.serializeAddress(_k, 'asp', address(_asp));
      vm.serializeAddress(_k, 'guardian', _guardian);
      vm.serializeAddress(_k, 'postman', address(_asp));
      vm.serializeUint(_k, 'aspWindow', _window);
      vm.serializeBool(_k, 'ownerRenounced', true);
      vm.serializeString(_k, 'scope', vm.toString(_pool.SCOPE()));
      string memory _json = vm.serializeAddress(_k, 'pool', address(_pool));
      vm.writeJson(_json, string.concat('./deployments/zeroprint-', vm.toString(block.chainid), '.json'));
    }
  }
}
