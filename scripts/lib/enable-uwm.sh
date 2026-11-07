#!/bin/bash
# Enable cluster-level user workload monitoring (UWM) for OpenShift.
# Sets enableUserWorkload: true in the cluster-monitoring-config ConfigMap, MERGING into
# any existing config (retention, storage, nodeSelectors... are preserved).
#
# Optionally enables Alertmanager for user workload monitoring when
# UWM_ENABLE_ALERTMANAGER=true (off by default — the workshop does not need it).
#
# Prerequisites:
# - oc CLI logged in to OpenShift cluster with cluster-admin privileges

# Source common utilities for colors and prerequisite checks
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# Constants
readonly CM_NAME="cluster-monitoring-config"
readonly CM_NAMESPACE="openshift-monitoring"
readonly CONFIG_FILE="$SCRIPT_DIR/../ocp_config/cluster-monitoring-config.yaml"
readonly UWM_CM_NAME="user-workload-monitoring-config"
readonly UWM_CM_NAMESPACE="openshift-user-workload-monitoring"

# Main function
main() {
    echo -e "${BLUE}→ Enabling cluster-level user workload monitoring...${NC}"
    echo ""

    # Step 1: Check prerequisites
    check_openshift_prerequisites
    check_file "$CONFIG_FILE" "Cluster monitoring config"
    check_tool_exists "yq"
    check_tool_exists "jq"

    # Step 2: Check if already enabled (idempotency)
    local uwm_already_enabled=false
    if is_user_workload_enabled; then
        echo -e "${GREEN}  ✅ User workload monitoring already enabled - skipping${NC}"
        uwm_already_enabled=true
    else
        # Step 3: Enable user workload monitoring
        echo -e "${BLUE}  → Enabling user workload monitoring...${NC}"
        enable_user_workload || exit 1
    fi

    # Step 4: Enable Alertmanager for user workload monitoring (opt-in)
    echo ""
    if [ "${UWM_ENABLE_ALERTMANAGER:-false}" != "true" ]; then
        echo -e "${BLUE}→ UWM Alertmanager not requested (UWM_ENABLE_ALERTMANAGER!=true) - skipping${NC}"
    elif is_alertmanager_enabled; then
        echo -e "${GREEN}  ✅ Alertmanager already enabled - skipping${NC}"
    else
        echo -e "${BLUE}→ Enabling Alertmanager for user workload monitoring...${NC}"
        enable_alertmanager || exit 1
    fi

    echo ""
    if [ "$uwm_already_enabled" = true ]; then
        echo -e "${GREEN}✅ User workload monitoring configuration verified!${NC}"
    else
        echo -e "${GREEN}✅ User workload monitoring enabled successfully!${NC}"
    fi
    echo ""
}

# Check if user workload monitoring is already enabled
is_user_workload_enabled() {
    # Get the config.yaml from the ConfigMap
    local config_yaml
    config_yaml=$(oc get configmap "$CM_NAME" -n "$CM_NAMESPACE" \
        -o jsonpath='{.data.config\.yaml}' 2>/dev/null)

    # If ConfigMap doesn't exist or is empty, user workload is not enabled
    if [ -z "$config_yaml" ] || [ "$config_yaml" = "null" ]; then
        debug "${BLUE}  → ConfigMap not found or empty${NC}"
        return 1
    fi

    # Check if enableUserWorkload is set to true (simple grep check)
    if echo "$config_yaml" | grep -q "enableUserWorkload: true"; then
        return 0
    fi

    debug "${BLUE}  → enableUserWorkload not found or not true${NC}"
    return 1
}

# Enable user workload monitoring. Creates the ConfigMap from $CONFIG_FILE when it does not
# exist; otherwise merges enableUserWorkload: true into the existing config.yaml so other
# cluster monitoring settings are preserved (a plain `oc apply` would replace them all).
enable_user_workload() {
    if ! oc get configmap "$CM_NAME" -n "$CM_NAMESPACE" >/dev/null 2>&1; then
        oc apply -f "$CONFIG_FILE" || {
            echo -e "${RED}❌ Failed to apply ConfigMap${NC}"
            return 1
        }
    else
        local current_config new_config
        current_config=$(oc get configmap "$CM_NAME" -n "$CM_NAMESPACE" \
            -o jsonpath='{.data.config\.yaml}' 2>/dev/null)
        [ -z "$current_config" ] && current_config="{}"
        new_config=$(echo "$current_config" | yq eval '.enableUserWorkload = true' -) || {
            echo -e "${RED}❌ Failed to parse existing $CM_NAME config.yaml${NC}"
            return 1
        }
        oc patch configmap "$CM_NAME" -n "$CM_NAMESPACE" --type merge \
            -p "$(jq -n --arg config "$new_config" '{data: {"config.yaml": $config}}')" || {
            echo -e "${RED}❌ Failed to patch ConfigMap${NC}"
            return 1
        }
    fi

    echo -e "${GREEN}  ✅ ConfigMap updated with enableUserWorkload: true${NC}"
    return 0
}

# Check if Alertmanager is enabled for user workload monitoring
is_alertmanager_enabled() {
    # Get the config.yaml from the user-workload-monitoring-config ConfigMap
    local config_yaml
    config_yaml=$(oc get configmap "$UWM_CM_NAME" -n "$UWM_CM_NAMESPACE" \
        -o jsonpath='{.data.config\.yaml}' 2>/dev/null)

    # If ConfigMap doesn't exist or is empty, Alertmanager is not enabled
    if [ -z "$config_yaml" ] || [ "$config_yaml" = "null" ]; then
        debug "${BLUE}  → ConfigMap not found or empty${NC}"
        return 1
    fi

    # Check if alertmanager.enabled is set to true
    if echo "$config_yaml" | yq eval '.alertmanager.enabled' - 2>/dev/null | grep -q "true"; then
        return 0
    fi

    debug "${BLUE}  → alertmanager.enabled not found or not true${NC}"
    return 1
}

# Enable Alertmanager for user workload monitoring
enable_alertmanager() {
    # Ensure the namespace exists
    if ! oc get namespace "$UWM_CM_NAMESPACE" >/dev/null 2>&1; then
        echo -e "${BLUE}  → Creating namespace $UWM_CM_NAMESPACE...${NC}"
        oc create namespace "$UWM_CM_NAMESPACE" || {
            echo -e "${RED}❌ Failed to create namespace $UWM_CM_NAMESPACE${NC}"
            return 1
        }
    fi

    # Get current config or start with empty object
    local current_config
    current_config=$(oc get configmap "$UWM_CM_NAME" -n "$UWM_CM_NAMESPACE" \
        -o jsonpath='{.data.config\.yaml}' 2>/dev/null)

    if [ -z "$current_config" ]; then
        current_config="{}"
    fi

    # Use yq to enable Alertmanager
    local new_config
    new_config=$(echo "$current_config" | yq eval '. as $item ireduce ({}; . * $item) |
        .alertmanager = (.alertmanager // {}) |
        .alertmanager.enabled = true |
        .alertmanager.enableAlertmanagerConfig = true' -)

    # Patch or create the ConfigMap
    if oc get configmap "$UWM_CM_NAME" -n "$UWM_CM_NAMESPACE" >/dev/null 2>&1; then
        # ConfigMap exists, patch it
        oc patch configmap "$UWM_CM_NAME" -n "$UWM_CM_NAMESPACE" \
            --type merge \
            -p "$(echo '{"data":{"config.yaml":""}}' | jq --arg config "$new_config" '.data."config.yaml" = $config')" || {
            echo -e "${RED}❌ Failed to patch ConfigMap${NC}"
            return 1
        }
    else
        # ConfigMap doesn't exist, create it
        oc create configmap "$UWM_CM_NAME" -n "$UWM_CM_NAMESPACE" \
            --from-literal=config.yaml="$new_config" || {
            echo -e "${RED}❌ Failed to create ConfigMap${NC}"
            return 1
        }
    fi

    echo -e "${GREEN}  ✅ Alertmanager enabled for user workload monitoring${NC}"
    echo -e "${BLUE}  → alertmanager.enabled = true${NC}"
    echo -e "${BLUE}  → alertmanager.enableAlertmanagerConfig = true${NC}"
    return 0
}

# Run main function
main "$@"
