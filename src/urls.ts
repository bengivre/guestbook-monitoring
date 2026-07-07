import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * URL for a Service that Pulumi manages directly (status is tracked in state).
 */
export function pulumiManagedServiceUrl(
    svc: k8s.core.v1.Service,
    useLoadBalancer: boolean,
    port: number,
    nodePort?: number,
): pulumi.Output<string> {
    if (!useLoadBalancer) {
        if (nodePort !== undefined) {
            return pulumi.output(`http://localhost:${nodePort}`);
        }
        return svc.spec.apply(spec => {
            const np = spec?.ports?.find(p => p.name === "http" || p.port === port)?.nodePort
                ?? spec?.ports?.[0]?.nodePort;
            return np ? `http://localhost:${np}` : "http://localhost:<nodePort pending>";
        });
    }
    return svc.status.apply(s => {
        const ing = s?.loadBalancer?.ingress?.[0];
        const host = ing?.hostname ?? ing?.ip ?? "<pending>";
        return `http://${host}${port === 80 ? "" : ":" + port}`;
    });
}

/**
 * URL for a Service created by a Helm chart (not readable via Service.get on first deploy).
 * NodePort: derived from Pulumi config passed into Helm values.
 * LoadBalancer: hostname/IP is only known after cloud provisioning — hint kubectl.
 */
export function helmManagedServiceUrl(
    useLoadBalancer: boolean,
    nodePort: number | undefined,
    port: number,
    namespace: pulumi.Input<string>,
    serviceName: pulumi.Input<string>,
): pulumi.Output<string> {
    if (!useLoadBalancer) {
        if (nodePort !== undefined) {
            return pulumi.output(`http://localhost:${nodePort}`);
        }
        return pulumi.interpolate`http://localhost:<set grafanaNodePort in Pulumi config>`;
    }
    return pulumi.interpolate`http://<pending — kubectl -n ${namespace} get svc ${serviceName} -o jsonpath='{.status.loadBalancer.ingress[0].ip}'>`;
}
