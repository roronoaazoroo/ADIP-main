# ============================================================
# FILE: training/train_xgboost.py
# ROLE: Trains XGBoost model on ADIP drift data, deploys to Azure ML
# Run: python training/train_xgboost.py
# Schedule: Weekly via Azure ML Pipeline
# ============================================================
import os
import json
import numpy as np
from datetime import datetime, timedelta
from collections import Counter, defaultdict
from azure.data.tables import TableServiceClient
from xgboost import XGBClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, classification_report
import joblib

from feature_engineering import build_feature_vector

# ── Config ────────────────────────────────────────────────────────────────────
STORAGE_CONN = os.environ['STORAGE_CONNECTION_STRING']
MODEL_PATH = 'model/drift_predictor.json'

# ── Load Data ─────────────────────────────────────────────────────────────────
def load_table_data(table_name):
    service = TableServiceClient.from_connection_string(STORAGE_CONN)
    table = service.get_table_client(table_name)
    return [entity for entity in table.list_entities()]


def main():
    print('[train] Loading data from Azure Table Storage...')
    changes_raw = load_table_data('changesIndex')
    drifts_raw = load_table_data('driftIndex')

    print(f'[train] Loaded {len(changes_raw)} changes, {len(drifts_raw)} drifts')

    # Group by resource
    changes_by_resource = defaultdict(list)
    for c in changes_raw:
        rid = (c.get('resourceId') or '').lower()
        if rid:
            changes_by_resource[rid].append({
                'detectedAt': c.get('detectedAt', ''),
                'caller': c.get('caller', ''),
                'changeType': c.get('changeType', ''),
            })

    drifts_by_resource = defaultdict(list)
    for d in drifts_raw:
        rid = (d.get('resourceId') or '').lower()
        if rid:
            drifts_by_resource[rid].append({
                'detectedAt': d.get('detectedAt', ''),
                'severity': d.get('severity', 'low'),
            })

    # Caller drift rates (global)
    caller_drift_counts = Counter()
    for d in drifts_raw:
        caller = d.get('caller', '')
        if caller:
            caller_drift_counts[caller] += 1

    # RG-level stats
    rg_drift_counts = Counter()
    rg_resource_counts = Counter()
    for d in drifts_raw:
        rg = d.get('resourceGroup', '')
        if rg:
            rg_drift_counts[rg.lower()] += 1
    for rid in changes_by_resource:
        parts = rid.split('/')
        rg = parts[4] if len(parts) > 4 else ''
        rg_resource_counts[rg.lower()] += 1

    # ── Build Training Dataset ────────────────────────────────────────────────
    print('[train] Building feature matrix...')
    X = []
    y = []

    for rid, changes in changes_by_resource.items():
        resource_drifts = drifts_by_resource.get(rid, [])
        parts = rid.split('/')
        rg = parts[4].lower() if len(parts) > 4 else ''

        # Sort changes by time
        changes.sort(key=lambda c: c['detectedAt'])

        # Create samples at different time points (sliding window)
        for i in range(max(1, len(changes) - 1)):
            # Use changes up to index i as history
            history_changes = changes[:i + 1]
            history_drifts = [d for d in resource_drifts if d['detectedAt'] <= changes[i]['detectedAt']]

            # Label: did this resource drift within 24h after this point?
            cutoff = changes[i]['detectedAt']
            try:
                cutoff_dt = datetime.fromisoformat(cutoff.replace('Z', ''))
                next_24h = (cutoff_dt + timedelta(hours=24)).isoformat()
                label = 1 if any(d['detectedAt'] > cutoff and d['detectedAt'] <= next_24h for d in resource_drifts) else 0
            except:
                continue

            features = build_feature_vector(
                resource_id=rid,
                changes=history_changes,
                drifts=history_drifts,
                baseline_date=None,
                all_drifts_by_caller=dict(caller_drift_counts),
                rg_drift_count=rg_drift_counts.get(rg, 0),
                rg_resource_count=rg_resource_counts.get(rg, 1),
            )

            X.append(features)
            y.append(label)

    X = np.array(X)
    y = np.array(y)
    print(f'[train] Dataset: {X.shape[0]} samples, {X.shape[1]} features')
    print(f'[train] Label distribution: {Counter(y)}')

    if len(X) < 20:
        print('[train] Not enough data to train. Exiting.')
        return

    # ── Train ─────────────────────────────────────────────────────────────────
    # Time-based split (no random shuffle — prevents data leakage)
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]

    print(f'[train] Train: {len(X_train)}, Test: {len(X_test)}')

    model = XGBClassifier(
        n_estimators=100,
        max_depth=5,
        learning_rate=0.1,
        scale_pos_weight=max(1, Counter(y_train)[0] / max(Counter(y_train)[1], 1)),
        eval_metric='auc',
        use_label_encoder=False,
    )
    model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)

    # ── Evaluate ──────────────────────────────────────────────────────────────
    y_pred_proba = model.predict_proba(X_test)[:, 1]
    auc = roc_auc_score(y_test, y_pred_proba) if len(set(y_test)) > 1 else 0.0
    print(f'[train] AUC-ROC: {auc:.4f}')
    print(classification_report(y_test, (y_pred_proba > 0.5).astype(int), target_names=['no_drift', 'drift']))

    # ── Save Model ────────────────────────────────────────────────────────────
    os.makedirs('model', exist_ok=True)
    model.save_model(MODEL_PATH)
    print(f'[train] Model saved to {MODEL_PATH}')

    # Export as ONNX for Node.js inference
    try:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
        import onnx
        initial_type = [('features', FloatTensorType([None, 13]))]
        onnx_model = convert_sklearn(model, initial_types=initial_type)
        onnx_path = 'model/drift_predictor.onnx'
        onnx.save_model(onnx_model, onnx_path)
        print(f'[train] ONNX model saved to {onnx_path}')
    except ImportError:
        print('[train] skl2onnx not installed — skipping ONNX export. Install: pip install skl2onnx onnx')

    # Feature importance
    importance = model.feature_importances_
    feature_names = [
        'change_frequency_7d', 'min_inter_arrival', 'drift_ratio', 'max_severity',
        'current_drift_streak', 'days_since_last_drift', 'recency_hours',
        'caller_entropy', 'caller_drift_rate', 'resource_type', 'rg_drift_density',
        'days_since_baseline', 'delete_event_ratio',
    ]
    print('\n[train] Feature importance:')
    for name, imp in sorted(zip(feature_names, importance), key=lambda x: -x[1]):
        bar = '█' * int(imp * 50)
        print(f'  {name:25s} {imp:.4f} {bar}')


if __name__ == '__main__':
    main()
