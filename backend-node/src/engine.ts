export type EngineName = "woocommerce" | "medusa";

export function buildEngineValues(args: {
  engine: EngineName;
  ingressClassName: string;
  host: string;
  secretName: string;
  chartRef?: string;
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
    livenessProbe:
      enabled: true
      initialDelaySeconds: 180
      periodSeconds: 15
      timeoutSeconds: 5
      failureThreshold: 6
    readinessProbe:
      enabled: true
      initialDelaySeconds: 60
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 6

ingress:
  enabled: true
  ingressClassName: ${args.ingressClassName}
  hostname: ${args.host}
  path: /
  tls: false

service:
  type: ClusterIP

livenessProbe:
  enabled: true
  timeoutSeconds: 5
readinessProbe:
  enabled: true
  timeoutSeconds: 5

extraPlugins:
  - woocommerce
`;

  return {
    chartRef: (args.chartRef ?? "").trim() || "bitnami/wordpress",
    valuesYaml,
    stubbed: false as const,
  };
}
