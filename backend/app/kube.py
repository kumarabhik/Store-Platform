import subprocess
from kubernetes import client, config
from kubernetes.client.exceptions import ApiException

def load_kube():
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
        
def ensure_namespace(name: str):
    v1 = client.CoreV1Api()
    try:
        v1.read_namespace(name)
        return
    except ApiException as e:
        if e.status != 404:
            raise
    ns = client.V1Namespace(metadata=client.V1ObjectMeta(name=name))
    v1.create_namespace(ns)
    
def delete_namespace(name:str):
    v1 = client.CoreV1Api()
    try:
        v1.delete_namespace(name)
    except ApiException as e:
        if e.status != 404:
            raise
def helm_install(release: str, chart_path: str, namespace: str, set_values: dict[str, str]):
    cmd = [
        "helm", "upgrade", "--install", release, chart_path,
        "--namespace", namespace,
        "--create-namespace",
        "--wait",
        "--timeout", "10m",
    ]
    for k, v in set_values.items():
        cmd.extend(["--set", f"{k}={v}"])
        
    subprocess.check_call(cmd)
    
def helm_uninstall(release: str, namespace: str):
    cmd = [
        "helm", "uninstall", release,
        "--namespace", namespace,
    ]
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError:
        pass
