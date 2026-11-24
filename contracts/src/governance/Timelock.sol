// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Brings OpenZeppelin's TimelockController into the build so that the deployment
// script can deploy it unmodified as the owner of Exchange and ChainlinkOracle.
// solhint-disable-next-line no-unused-import
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
