import k8s from "@kubernetes/client-node";

export async function isDeploymentAvailable(apps: k8s.AppsV1Api, ns: string, name: string) {
  const d = await apps.readNamespacedDeployment(name, ns);
  const conditions = d.body.status?.conditions ?? [];
  return conditions.some((c) => c.type === "Available" && c.status === "True");
}

export async function ingressExists(net: k8s.NetworkingV1Api, ns: string, name: string) {
  try {
    await net.readNamespacedIngress(name, ns);
    return true;
  } catch (e: any) {
    if (e?.response?.statusCode === 404) return false;
    throw e;
  }
}

export async function waitForReadiness(
  apps: k8s.AppsV1Api,
  net: k8s.NetworkingV1Api,
  ns: string,
  deploymentName: string,
  ingressName: string,
  timeoutMs: number
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const depOk = await isDeploymentAvailable(apps, ns, deploymentName);
    const ingOk = await ingressExists(net, ns, ingressName);
    if (depOk && ingOk) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
