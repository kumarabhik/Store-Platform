export type EngineName = "woocommerce" | "medusa";

export function buildEngineValues(args: {
  engine: EngineName;
  ingressClassName: string;
  host: string;
  secretName: string;
}) {
  if (args.engine === "medusa") {
    return {
      chartRef: "",
      valuesYaml: "",
      stubbed: true as const,
      reason: "medusa engine stubbed (not implemented in Round 1)",
    };
  }

  const valuesYaml = `
wordpressUsername: admin
existingSecret: ${args.secretName}
existingSecretPasswordKey: wp_admin_password

persistence:
  enabled: true
  size: 2Gi

mariadb:
  enabled: true
  auth:
    existingSecret: ${args.secretName}
    existingSecretRootPasswordKey: mariadb_root_password
    existingSecretPasswordKey: mariadb_password
  primary:
    persistence:
      enabled: true
      size: 5Gi

ingress:
  enabled: true
  ingressClassName: ${args.ingressClassName}
  hostname: ${args.host}
  path: /
  tls: false

extraPlugins:
  - woocommerce
`;

  return {
    chartRef: "bitnami/wordpress",
    valuesYaml,
    stubbed: false as const,
  };
}
