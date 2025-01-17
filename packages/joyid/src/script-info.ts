import {
  Cell,
  QueryOptions,
  Script,
  WitnessArgs,
  blockchain,
  CellCollector,
  CellProvider,
  utils,
  Address,
  CellDep,
  HexString,
  HashType,
} from "@ckb-lumos/base";
import { bytes } from "@ckb-lumos/codec";
import { parseAddress } from "@ckb-lumos/helpers";
import { Aggregator, getJoyIDCellDep, getJoyIDLockScript } from "@joyid/ckb";
import {
  FromInfo,
  LockScriptInfo,
  parseFromInfo,
} from "@ckb-lumos/common-scripts";
import { addCellDep } from "@ckb-lumos/common-scripts/lib/helper";
import { getCotaTypeScript } from "./constants";
import { Config, getConfig, predefined } from "@ckb-lumos/config-manager";

export class JoyIDCellCollector {
  readonly fromScript: Script;
  private readonly cellCollector: CellCollector;

  constructor(
    private fromInfo: FromInfo,
    cellProvider: CellProvider,
    {
      queryOptions = {},
      config = getConfig(),
    }: { queryOptions?: QueryOptions; config?: Config }
  ) {
    if (!cellProvider) {
      throw new Error(
        `cellProvider is required when collecting JoyID-related cells`
      );
    }

    if (typeof fromInfo !== "string") {
      throw new Error(`Only the address FromInfo is supported`);
    }

    const { fromScript } = parseFromInfo(fromInfo, { config });
    this.fromScript = fromScript;

    queryOptions = {
      ...queryOptions,
      lock: this.fromScript,
      type: queryOptions.type || "empty",
      data: queryOptions.data || "0x",
    };

    this.cellCollector = cellProvider.collector(queryOptions);
  }

  async *collect(): AsyncGenerator<Cell> {
    const joyIdMainnetCodeHash = getJoyIDLockScript(true).codeHash;
    const joyIdTestnetCodeHash = getJoyIDLockScript(false).codeHash;
    if (
      !bytes.equal(this.fromScript.codeHash, joyIdMainnetCodeHash) &&
      !bytes.equal(this.fromScript.codeHash, joyIdTestnetCodeHash)
    ) {
      return;
    }

    for await (const inputCell of this.cellCollector.collect()) {
      yield inputCell;
    }
  }
}

type HexStringWithout0x = string;

export type Connection = {
  pubkey: HexStringWithout0x;
  // ckb address
  address: Address;
  keyType: "main_key" | "sub_key" | string;
};

export type JoyIDScriptInfoConfig = {
  aggregator: Pick<Aggregator, "generateSubkeyUnlockSmt">;
  cellDeps: CellDep[];
  joyIdLockScriptTemplate: { codeHash: HexString; hashType: HashType };
  cotaTypeScriptTemplate: { codeHash: HexString; hashType: HashType };
};

/* c8 ignore start */
/**
 * get the builtin mainnet or testnet config to {@link createJoyIDScriptInfo}
 * @param isMainnet
 */
export function getDefaultConfig(isMainnet: boolean): JoyIDScriptInfoConfig {
  // https://github.com/nervina-labs/cota-sdk-js/blob/f80d04ea532d72cfe7410ea45af6dc583e140edf/README.md?plain=1#L46-L52
  const aggregatorUrl = isMainnet
    ? "https://cota.nervina.dev/mainnet-aggregator"
    : "https://cota.nervina.dev/aggregator";

  return {
    aggregator: new Aggregator(aggregatorUrl),
    cellDeps: [getJoyIDCellDep(isMainnet)],
    joyIdLockScriptTemplate: getJoyIDLockScript(isMainnet),
    cotaTypeScriptTemplate: getCotaTypeScript(isMainnet),
  };
}
/* c8 ignore end */

/**
 * create a JoyID ScriptInfo to register it to common-scripts
 * @example
 *
 * import { connect } from "@joyid/ckb"
 * import { registerCustomLockScriptInfos } from "@ckb-lumos/lumos/common-scripts/common"
 *
 * // connect to JoyID
 * const connection = await connect()
 *
 * // create JoyID ScriptInfo
 * const joyIDScriptInfo = createJoyIDScriptInfo(
 *   connection,
 *   getJoyIDScriptInfo(true),
 *   // or you can override it by demand
 *   // {...getJoyIDScriptInfo(true), aggregator: new Aggregator('/path/to/aggreagator')}
 * )
 *
 * // register the ScriptInfo into the common-scripts
 * registerCustomLockScriptInfos(joyIDScriptInfo)
 *
 * @param connection the JoyID connection
 * @param config {@link getDefaultConfig}
 */
export function createJoyIDScriptInfo(
  connection: Connection,
  config: JoyIDScriptInfoConfig
): LockScriptInfo {
  const {
    joyIdLockScriptTemplate,
    cotaTypeScriptTemplate,
    cellDeps: joyIdCellDeps,
    aggregator,
  } = config;

  asserts(
    connection.keyType === "main_key" || connection.keyType === "sub_key",
    `Unsupported keyType: ${connection.keyType}, only support main_key or sub_key`
  );

  return {
    codeHash: joyIdLockScriptTemplate.codeHash,
    hashType: "type",
    lockScriptInfo: {
      CellCollector: JoyIDCellCollector,
      prepareSigningEntries: () => {
        throw new Error(
          "JoyID doesn't support prepareSigningEntries, please do not mix JoyID locks with other locks in a transaction"
        );
      },
      async setupInputCell(txSkeleton, inputCell, _, options = {}) {
        const fromScript = inputCell.cellOutput.lock;
        asserts(
          bytes.equal(fromScript.codeHash, joyIdLockScriptTemplate.codeHash),
          `The input script is not JoyID script`
        );
        // add inputCell to txSkeleton
        txSkeleton = txSkeleton.update("inputs", (inputs) =>
          inputs.push(inputCell)
        );

        const output: Cell = {
          cellOutput: {
            capacity: inputCell.cellOutput.capacity,
            lock: inputCell.cellOutput.lock,
            type: inputCell.cellOutput.type,
          },
          data: inputCell.data,
        };

        txSkeleton = txSkeleton.update("outputs", (outputs) =>
          outputs.push(output)
        );

        const since = options.since;
        if (since) {
          txSkeleton = txSkeleton.update("inputSinces", (inputSinces) => {
            return inputSinces.set(txSkeleton.get("inputs").size - 1, since);
          });
        }

        const firstIndex = txSkeleton
          .get("inputs")
          .findIndex((input) =>
            bytes.equal(
              blockchain.Script.pack(input.cellOutput.lock),
              blockchain.Script.pack(fromScript)
            )
          );
        if (firstIndex !== -1) {
          while (firstIndex >= txSkeleton.get("witnesses").size) {
            txSkeleton = txSkeleton.update("witnesses", (witnesses) =>
              witnesses.push("0x")
            );
          }

          const lock = parseAddressAuto(connection.address);

          // will change if the connection.keyType is a sub_key
          let newWitnessArgs: WitnessArgs = {
            lock: "0x",
          };

          const BLAKE160_LENGTH = 20;
          if (connection.keyType === "sub_key") {
            //https://github.com/nervina-labs/ckb-dex-sdk/blob/b34c0b98e63ae1cfadcc9f9430a8d2a606f77a15/src/order/cancel.ts#L117C33-L117C41
            const pubkeyHash = bytes
              .bytify(utils.ckbHash("0x" + connection.pubkey))
              .slice(0, BLAKE160_LENGTH);

            const { unlock_entry: unlockEntry } =
              await aggregator.generateSubkeyUnlockSmt({
                alg_index: 1,
                pubkey_hash: bytes.hexify(pubkeyHash),
                lock_script: bytes.hexify(blockchain.Script.pack(lock)),
              });
            newWitnessArgs = {
              lock: "0x",
              outputType: "0x" + unlockEntry,
            };

            const cellProvider = txSkeleton.get("cellProvider");
            asserts(
              cellProvider != null,
              "Cell provider is missing while collecting CoTA cell"
            );

            const cotaCollector = cellProvider.collector({
              lock: lock,
              type: { ...cotaTypeScriptTemplate, args: "0x" },
            });

            const cotaCells: Cell[] = [];
            for await (const cotaCell of cotaCollector.collect()) {
              cotaCells.push(cotaCell);
            }

            if (!cotaCells || cotaCells.length === 0) {
              throw new Error("Cota cell doesn't exist");
            }

            cotaCells.forEach((cotaCell) => {
              const outPoint = cotaCell.outPoint;
              asserts(outPoint != null);
              // note: COTA cell MUST put first
              txSkeleton = addCellDep(txSkeleton, {
                outPoint,
                depType: "code",
              });
            });
          }

          joyIdCellDeps.forEach((item) => {
            txSkeleton = addCellDep(txSkeleton, item);
          });

          const witness = bytes.hexify(
            blockchain.WitnessArgs.pack(newWitnessArgs)
          );
          txSkeleton = txSkeleton.update("witnesses", (witnesses) =>
            witnesses.set(firstIndex, witness)
          );
        }

        return txSkeleton;
      },
    },
  };
}

function asserts(
  condition: unknown,
  message = "Assert failed"
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseAddressAuto(address: string): Script {
  const config = address.startsWith("ckt")
    ? predefined.AGGRON4
    : predefined.LINA;

  return parseAddress(address, { config });
}
