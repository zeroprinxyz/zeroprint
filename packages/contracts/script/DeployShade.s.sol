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

/**
 * @title ShadePool deployment
 * @notice Deploys the unmodified 0xbow protocol with a single native ETH pool, then renounces OWNER_ROLE
 *         so nobody can upgrade, register/remove/wind down pools or touch fees afterwards.
 *         Only ASP_POSTMAN remains: it can publish association-set roots, never move funds (ragequit).
 * @dev No CreateX, so it works on any EVM chain. Env:
 *      POSTMAN_ADDRESS   ASP postman
 *      MIN_DEPOSIT       wei, default 0.001 ether
 *      MAX_RELAY_FEE_BPS default 50 (0.5%)
 *      RENOUNCE          default true
 */
contract DeployShade is Script {
  bytes32 internal constant _OWNER_ROLE = keccak256('OWNER_ROLE');

  function run() external returns (Entrypoint _entrypoint, PrivacyPoolSimple _pool) {
    address _postman = vm.envAddress('POSTMAN_ADDRESS');
    uint256 _minDeposit = vm.envOr('MIN_DEPOSIT', uint256(0.001 ether));
    uint256 _maxRelayFeeBPS = vm.envOr('MAX_RELAY_FEE_BPS', uint256(50));
    bool _renounce = vm.envOr('RENOUNCE', true);

    vm.startBroadcast();
    (, address _deployer,) = vm.readCallers();

    address _withdrawalVerifier = address(new WithdrawalVerifier());
    address _ragequitVerifier = address(new CommitmentVerifier());

    address _impl = address(new Entrypoint());
    _entrypoint =
      Entrypoint(payable(new ERC1967Proxy(_impl, abi.encodeCall(Entrypoint.initialize, (_deployer, _postman)))));

    _pool = new PrivacyPoolSimple(address(_entrypoint), _withdrawalVerifier, _ragequitVerifier);

    // Vetting fee 0: fees could only be pulled by OWNER, which is renounced below
    _entrypoint.registerPool(
      IERC20(Constants.NATIVE_ASSET), IPrivacyPool(address(_pool)), _minDeposit, 0, _maxRelayFeeBPS
    );

    if (_renounce) _entrypoint.renounceRole(_OWNER_ROLE, _deployer);
    vm.stopBroadcast();

    console.log('WithdrawalVerifier:', _withdrawalVerifier);
    console.log('CommitmentVerifier:', _ragequitVerifier);
    console.log('Entrypoint impl:   ', _impl);
    console.log('Entrypoint proxy:  ', address(_entrypoint));
    console.log('ETH pool:          ', address(_pool));
    console.log('Pool scope:        ', _pool.SCOPE());
    console.log('Owner renounced:   ', _renounce);

    if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
      string memory _k = 'shade';
      vm.serializeUint(_k, 'chainId', block.chainid);
      vm.serializeUint(_k, 'startBlock', block.number);
      vm.serializeAddress(_k, 'withdrawalVerifier', _withdrawalVerifier);
      vm.serializeAddress(_k, 'ragequitVerifier', _ragequitVerifier);
      vm.serializeAddress(_k, 'entrypointImpl', _impl);
      vm.serializeAddress(_k, 'entrypoint', address(_entrypoint));
      vm.serializeAddress(_k, 'postman', _postman);
      vm.serializeBool(_k, 'ownerRenounced', _renounce);
      vm.serializeString(_k, 'scope', vm.toString(_pool.SCOPE()));
      string memory _json = vm.serializeAddress(_k, 'pool', address(_pool));
      vm.writeJson(_json, string.concat('./deployments/shade-', vm.toString(block.chainid), '.json'));
    }
  }
}
