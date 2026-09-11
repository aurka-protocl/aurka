// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { AurkaPolicyRegistry } from "./AurkaPolicyRegistry.sol";
import { IAqua } from "./interfaces/IAqua.sol";
import { IERC20Minimal } from "./interfaces/IERC20Minimal.sol";
import { ISwapVM } from "./interfaces/ISwapVM.sol";
import { AurkaSwapVMExecutionGuard } from "./AurkaSwapVMExecutionGuard.sol";

interface IAurkaSepoliaOrderValidatorExecutor {
    function expectedAmountOut(
        uint256 traderInputValue,
        uint8 traderOutputDecimals,
        uint256 traderOutputPrice,
        uint8 traderOutputPriceDecimals
    ) external pure returns (uint256);

    function validate(
        address traderInputToken,
        address traderOutputToken,
        address swapVMGuard,
        uint256 makerTraits,
        bytes calldata orderData,
        bytes calldata takerTraitsAndData,
        uint256 expectedAmountOut,
        uint256 deadline
    ) external view;
}

/// @notice Executes the already validated upstream SwapVM/Aqua movement.
/// @dev The router owns the policy and accounting decision. This contract is
///      only a size boundary: it can execute once initialized by that router,
///      and its guard binds the upstream maker hook to this executor address.
contract AurkaSepoliaUpstreamExecutor {
    ISwapVM public immutable swapVM;
    IAqua public immutable aqua;
    AurkaPolicyRegistry public immutable policyRegistry;
    IAurkaSepoliaOrderValidatorExecutor public immutable orderValidator;
    address public immutable swapVMGuard;
    address public immutable initializer;
    address public router;

    mapping(bytes32 orderHash => SwapVMExecution execution) private _executions;

    struct SwapVMExecution {
        address maker;
        address trader;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
    }

    error InvalidAddress();
    error InvalidRouter();
    error NotInitializer();
    error NotRouter();
    error SwapVMExecutionMismatch();
    error SwapVMDirectCall();
    error StrategyNotAuthorized();
    error TokenBalanceMismatch(address token, uint256 expected, uint256 actual);
    error TokenTransferFailed(address token);

    constructor(
        ISwapVM swapVM_,
        IAqua aqua_,
        AurkaPolicyRegistry policyRegistry_,
        IAurkaSepoliaOrderValidatorExecutor orderValidator_
    ) {
        if (
            address(swapVM_) == address(0) || address(aqua_) == address(0)
                || address(policyRegistry_) == address(0) || address(orderValidator_) == address(0)
        ) revert InvalidAddress();
        swapVM = swapVM_;
        aqua = aqua_;
        policyRegistry = policyRegistry_;
        orderValidator = orderValidator_;
        initializer = msg.sender;
        swapVMGuard = address(new AurkaSwapVMExecutionGuard(address(this), address(swapVM_)));
    }

    function initializeRouter(address router_) external {
        if (msg.sender != initializer) revert NotInitializer();
        if (router != address(0) || router_ == address(0)) revert InvalidRouter();
        router = router_;
    }

    modifier onlyRouter() {
        if (msg.sender != router || router == address(0)) revert NotRouter();
        _;
    }

    function validateSwapVMExecution(
        bytes32 orderHash,
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external view {
        if (msg.sender != swapVMGuard) revert SwapVMDirectCall();
        SwapVMExecution memory execution = _executions[orderHash];
        if (
            execution.maker != maker || execution.trader == address(0) || taker != address(this)
                || execution.tokenIn != tokenIn || execution.tokenOut != tokenOut
                || execution.amountIn != amountIn || execution.amountOut != amountOut
        ) revert SwapVMDirectCall();
    }

    function execute(
        address treasury,
        address trader,
        address solver,
        address traderInputToken,
        address traderOutputToken,
        bytes32 policyId,
        bytes32 strategyHash,
        uint256 traderInputAmount,
        uint256 traderOutputAmount,
        uint256 solverFeeAmount,
        uint256 protocolFeeAmount,
        uint256 treasuryOutputAmount,
        uint256 traderInputValue,
        uint8 traderOutputDecimals,
        uint256 traderOutputPrice,
        uint8 traderOutputPriceDecimals,
        uint256 deadline,
        uint256 makerTraits,
        bytes calldata orderData,
        bytes calldata takerTraitsAndData
    ) external onlyRouter returns (bytes32 orderHash, uint256 amountIn, uint256 amountOut) {
        ISwapVM.Order memory order =
            ISwapVM.Order({ maker: treasury, traits: makerTraits, data: orderData });
        orderHash = swapVM.hash(order);
        if (orderHash != strategyHash) revert StrategyNotAuthorized();
        uint256 vmAmountOut = orderValidator.expectedAmountOut(
            traderInputValue,
            traderOutputDecimals,
            traderOutputPrice,
            traderOutputPriceDecimals
        );
        orderValidator.validate(
            traderInputToken,
            traderOutputToken,
            swapVMGuard,
            makerTraits,
            orderData,
            takerTraitsAndData,
            vmAmountOut,
            deadline
        );
        (uint256 quotedIn, uint256 quotedOut, bytes32 quotedOrderHash) =
            swapVM.quote(order, traderInputAmount, takerTraitsAndData);
        if (
            quotedOrderHash != orderHash || quotedIn != traderInputAmount || quotedOut != vmAmountOut
        ) revert SwapVMExecutionMismatch();

        IERC20Minimal inputToken = IERC20Minimal(traderInputToken);
        IERC20Minimal outputToken = IERC20Minimal(traderOutputToken);
        uint256 inputBefore = inputToken.balanceOf(address(this));
        uint256 outputBefore = outputToken.balanceOf(address(this));
        _approve(inputToken, address(swapVM), traderInputAmount);
        _executions[orderHash] = SwapVMExecution({
            maker: treasury,
            trader: trader,
            tokenIn: traderInputToken,
            tokenOut: traderOutputToken,
            amountIn: traderInputAmount,
            amountOut: vmAmountOut
        });
        (amountIn, amountOut,) = swapVM.swap(order, traderInputAmount, takerTraitsAndData);
        delete _executions[orderHash];
        _approve(inputToken, address(swapVM), 0);
        if (amountIn != traderInputAmount || amountOut != vmAmountOut) {
            revert SwapVMExecutionMismatch();
        }
        uint256 expectedInputBalance =
            inputBefore >= amountIn ? inputBefore - amountIn : type(uint256).max;
        if (inputToken.balanceOf(address(this)) != expectedInputBalance) {
            revert TokenBalanceMismatch(
                traderInputToken, expectedInputBalance, inputToken.balanceOf(address(this))
            );
        }
        if (outputToken.balanceOf(address(this)) != outputBefore + amountOut) {
            revert TokenBalanceMismatch(
                traderOutputToken, outputBefore + amountOut, outputToken.balanceOf(address(this))
            );
        }

        _transferExact(outputToken, trader, traderOutputAmount);
        _transferExact(outputToken, solver, solverFeeAmount);
        address protocolRecipient = policyRegistry.feeConfiguration(policyId).protocolFeeRecipient;
        _transferExact(outputToken, protocolRecipient, protocolFeeAmount);
        if (vmAmountOut < treasuryOutputAmount) revert SwapVMExecutionMismatch();
        uint256 treasuryFeeAmount = vmAmountOut - treasuryOutputAmount;
        if (outputToken.balanceOf(address(this)) != outputBefore + treasuryFeeAmount) {
            revert TokenBalanceMismatch(
                traderOutputToken,
                outputBefore + treasuryFeeAmount,
                outputToken.balanceOf(address(this))
            );
        }
        if (treasuryFeeAmount > 0) {
            _approve(outputToken, address(aqua), treasuryFeeAmount);
            aqua.push(treasury, address(swapVM), orderHash, traderOutputToken, treasuryFeeAmount);
            _approve(outputToken, address(aqua), 0);
        }
        if (outputToken.balanceOf(address(this)) != outputBefore) {
            revert TokenBalanceMismatch(
                traderOutputToken, outputBefore, outputToken.balanceOf(address(this))
            );
        }
    }

    function _transferExact(IERC20Minimal token, address to, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(to);
        if (!token.transfer(to, amount)) revert TokenTransferFailed(address(token));
        if (token.balanceOf(to) != beforeBalance + amount) {
            revert TokenBalanceMismatch(address(token), beforeBalance + amount, token.balanceOf(to));
        }
    }

    function _approve(IERC20Minimal token, address spender, uint256 amount) private {
        if (!token.approve(spender, amount)) revert TokenTransferFailed(address(token));
    }
}
