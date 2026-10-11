# The image the provisioner's Helm jobs run (DESIGN §11): helm plus this chart at /chart, so a
# new store installs offline, without a chart repository, and always with the chart version that
# matches the platform release. Build: `minikube image build -t store-platform/store-chart:dev charts/store-woocommerce`.
FROM alpine/helm:3.14.4

COPY --chown=65534:65534 . /chart

# Same non-root user the job's securityContext uses; helm needs only a writable HOME (an emptyDir).
USER 65534
ENV HOME=/tmp
