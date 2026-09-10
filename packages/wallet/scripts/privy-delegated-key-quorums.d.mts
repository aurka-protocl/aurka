export declare function verifyAuthorizationKeyBinding(input: {
  quorum: unknown;
  quorumId: string;
  privateKey: string;
  variableName: string;
}): {
  id: string;
  threshold: number;
  registeredKeyCount: number;
  configuredKeyCount: number;
  thresholdSatisfied: true;
};

export declare function verifyAuthorizationKeyQuorums(
  client: unknown,
): Promise<{
  owner: ReturnType<typeof verifyAuthorizationKeyBinding>;
  signer: ReturnType<typeof verifyAuthorizationKeyBinding>;
}>;
