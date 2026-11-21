// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SignalLog — daily research-digest anchor for StockSentinel (Base Sepolia)
/// @notice The agent anchors a hash of its daily signal digest here so its
///         research activity is verifiable onchain. Holds no funds, moves no
///         value; research attestation only.
contract SignalLog {
    event Anchored(
        address indexed agent,
        bytes32 indexed digest,
        uint64 signalCount,
        uint64 dayIndex,
        uint256 timestamp
    );

    address public immutable agent;
    uint64 public anchorCount;
    bytes32 public lastDigest;

    constructor(address agent_) {
        agent = agent_;
    }

    function anchor(bytes32 digest, uint64 signalCount, uint64 dayIndex) external {
        require(msg.sender == agent, "only agent");
        anchorCount += 1;
        lastDigest = digest;
        emit Anchored(msg.sender, digest, signalCount, dayIndex, block.timestamp);
    }
}
