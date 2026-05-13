# ============================================================
# FILE: training/feature_engineering.py
# ROLE: Builds 13-feature vector per resource from Table Storage data
# ============================================================
import math
from collections import Counter
from datetime import datetime, timedelta


def compute_caller_entropy(callers):
    """Shannon entropy of caller distribution."""
    if not callers:
        return 0.0
    total = len(callers)
    counts = Counter(callers)
    entropy = 0.0
    for count in counts.values():
        p = count / total
        if p > 0:
            entropy -= p * math.log2(p)
    return entropy


def build_feature_vector(resource_id, changes, drifts, baseline_date=None, all_drifts_by_caller=None, rg_drift_count=0, rg_resource_count=1):
    """
    Builds a 13-element feature vector for one resource.

    Args:
        resource_id: ARM resource ID
        changes: list of change events for this resource [{detectedAt, caller, changeType}]
        drifts: list of drift events for this resource [{detectedAt, severity}]
        baseline_date: ISO string when baseline was last set
        all_drifts_by_caller: dict {caller: total_drift_count} across all resources
        rg_drift_count: total drifts in the same resource group
        rg_resource_count: total resources in the same resource group
    """
    now = datetime.utcnow()
    total_changes = len(changes)

    if total_changes == 0:
        return [0.0] * 13

    # Parse timestamps
    change_times = []
    for c in changes:
        try:
            change_times.append(datetime.fromisoformat(c['detectedAt'].replace('Z', '')))
        except:
            pass
    change_times.sort()

    drift_times = []
    for d in drifts:
        try:
            drift_times.append(datetime.fromisoformat(d['detectedAt'].replace('Z', '')))
        except:
            pass
    drift_times.sort()

    # Feature 1: change_frequency_7d
    seven_days_ago = now - timedelta(days=7)
    changes_7d = sum(1 for t in change_times if t >= seven_days_ago)
    change_frequency_7d = changes_7d / 7.0

    # Feature 2: min_inter_arrival_hours
    inter_arrivals = []
    for i in range(1, len(change_times)):
        delta_hours = (change_times[i] - change_times[i - 1]).total_seconds() / 3600
        inter_arrivals.append(delta_hours)
    min_inter_arrival = min(inter_arrivals) if inter_arrivals else 720.0

    # Feature 3: drift_ratio
    drift_ratio = len(drifts) / total_changes if total_changes > 0 else 0.0

    # Feature 4: max_severity_score
    severity_map = {'low': 0, 'medium': 1, 'high': 2, 'critical': 3}
    max_severity = 0
    for d in drifts:
        s = severity_map.get(d.get('severity', 'low'), 0)
        max_severity = max(max_severity, s)

    # Feature 5: current_drift_streak
    streak = 0
    if drift_times:
        streak = 1
        for i in range(len(drift_times) - 1, 0, -1):
            if (drift_times[i] - drift_times[i - 1]).total_seconds() / 3600 < 24:
                streak += 1
            else:
                break

    # Feature 6: days_since_last_drift
    days_since_last_drift = 30.0
    if drift_times:
        days_since_last_drift = (now - drift_times[-1]).total_seconds() / 86400

    # Feature 7: recency_hours
    recency_hours = 720.0
    if change_times:
        recency_hours = (now - change_times[-1]).total_seconds() / 3600

    # Feature 8: caller_entropy
    callers = [c.get('caller', '') for c in changes if c.get('caller')]
    caller_entropy = compute_caller_entropy(callers)

    # Feature 9: caller_drift_rate
    caller_drift_rate = 0.0
    if callers and all_drifts_by_caller:
        primary_caller = Counter(callers).most_common(1)[0][0]
        primary_total = all_drifts_by_caller.get(primary_caller, 0)
        # Normalize by assuming max 50 drifts per caller
        caller_drift_rate = min(primary_total / 50.0, 1.0)

    # Feature 10: resource_type_encoded
    type_map = {
        'storageaccounts': 0, 'virtualmachines': 1, 'vaults': 2,
        'networksecuritygroups': 3, 'sites': 4, 'workflows': 5,
    }
    parts = resource_id.lower().split('/')
    rtype = parts[7] if len(parts) > 7 else ''
    resource_type_encoded = type_map.get(rtype, 6)

    # Feature 11: rg_drift_density
    rg_drift_density = rg_drift_count / max(rg_resource_count, 1)

    # Feature 12: days_since_baseline_set
    days_since_baseline = 30.0
    if baseline_date:
        try:
            bl_dt = datetime.fromisoformat(baseline_date.replace('Z', ''))
            days_since_baseline = (now - bl_dt).total_seconds() / 86400
        except:
            pass

    # Feature 13: delete_event_ratio
    delete_count = sum(1 for c in changes if c.get('changeType') == 'deleted')
    delete_event_ratio = delete_count / total_changes

    return [
        change_frequency_7d,
        min_inter_arrival,
        drift_ratio,
        float(max_severity),
        float(streak),
        days_since_last_drift,
        recency_hours,
        caller_entropy,
        caller_drift_rate,
        float(resource_type_encoded),
        rg_drift_density,
        days_since_baseline,
        delete_event_ratio,
    ]
