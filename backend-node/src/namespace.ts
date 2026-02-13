import k8s from "@kubernetes/client-node";

export async function waitForNamespaceGone(core: k8s.CoreV1Api, ns: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await core.readNamespace(ns);
    } catch (e: any) {
      if (e?.response?.statusCode === 404) return true;
      throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
