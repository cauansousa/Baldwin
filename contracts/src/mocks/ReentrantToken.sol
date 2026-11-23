// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test token that calls back into a target during transfers.
contract ReentrantToken is ERC20 {
    address private _target;
    bytes private _data;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target, bytes calldata data) external {
        _target = target;
        _data = data;
    }

    function disarm() external {
        _target = address(0);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (_target != address(0) && from != address(0)) {
            (bool ok, bytes memory ret) = _target.call(_data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
