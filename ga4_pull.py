#!/usr/bin/env python3
"""
GA4 Data Pull — caches website analytics for the dashboard
Runs every 4 hours via launchd (ai.dwe.ga4-pull)
Saves to ~/mission-control-server/ga4_cache.json
"""
import json, os, sys
from datetime import datetime

SA_JSON = os.path.expanduser('~/.openclaw/credentials/ga4-service-account.json')
CACHE_PATH = os.path.join(os.path.expanduser('~/mission-control-server'), 'ga4_cache.json')
PROPERTY = 'properties/349790229'
LOG = os.path.expanduser('~/openclaw/logs/ga4-pull.log')
SCOPES = ['https://www.googleapis.com/auth/analytics.readonly']

def log(msg):
    with open(LOG, 'a') as f:
        f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
except ImportError:
    log("ERROR: google-auth or google-api-python-client not installed")
    sys.exit(1)

def get_creds():
    creds = service_account.Credentials.from_service_account_file(SA_JSON, scopes=SCOPES)
    return creds

def pull():
    log("Starting GA4 pull...")
    creds = get_creds()
    api = build('analyticsdata', 'v1beta', credentials=creds)

    # This week vs last week
    # NOTE: GA4 returns the date range 'name' value in dimensionValues, not 'date_range_0'
    compare = api.properties().runReport(property=PROPERTY, body={
        'dateRanges': [
            {'startDate': '7daysAgo', 'endDate': 'today', 'name': 'thisWeek'},
            {'startDate': '14daysAgo', 'endDate': '8daysAgo', 'name': 'lastWeek'}
        ],
        'metrics': [
            {'name': 'sessions'},
            {'name': 'totalUsers'},
            {'name': 'newUsers'},
            {'name': 'screenPageViews'},
            {'name': 'averageSessionDuration'},
            {'name': 'bounceRate'},
            {'name': 'engagedSessions'},
            {'name': 'engagementRate'}
        ]
    }).execute()

    periods = {}
    for row in compare.get('rows', []):
        # GA4 returns the name we gave the date range directly
        name = row['dimensionValues'][0]['value']  # 'thisWeek' or 'lastWeek'
        if name not in ('thisWeek', 'lastWeek'):
            continue
        m = row['metricValues']
        periods[name] = {
            'sessions': int(m[0]['value']),
            'users': int(m[1]['value']),
            'newUsers': int(m[2]['value']),
            'pageviews': int(m[3]['value']),
            'avgDuration': round(float(m[4]['value'])),
            'bounceRate': round(float(m[5]['value']) * 100, 1),
            'engaged': int(m[6]['value']),
            'engagementRate': round(float(m[7]['value']) * 100, 1)
        }

    # Calculate deltas
    tw = periods.get('thisWeek', {})
    lw = periods.get('lastWeek', {})
    deltas = {}
    for key in ['sessions', 'users', 'pageviews']:
        curr = tw.get(key, 0)
        prev = lw.get(key, 0)
        if prev > 0:
            deltas[key] = round((curr - prev) / prev * 100, 1)
        elif curr > 0:
            deltas[key] = 100.0
        else:
            deltas[key] = 0.0

    # Top pages
    pages_resp = api.properties().runReport(property=PROPERTY, body={
        'dateRanges': [{'startDate': '7daysAgo', 'endDate': 'today'}],
        'dimensions': [{'name': 'pagePath'}],
        'metrics': [{'name': 'screenPageViews'}, {'name': 'totalUsers'}],
        'orderBys': [{'metric': {'metricName': 'screenPageViews'}, 'desc': True}],
        'limit': 5
    }).execute()

    top_pages = []
    for row in pages_resp.get('rows', []):
        top_pages.append({
            'path': row['dimensionValues'][0]['value'],
            'views': int(row['metricValues'][0]['value']),
            'users': int(row['metricValues'][1]['value'])
        })

    # Traffic sources
    sources_resp = api.properties().runReport(property=PROPERTY, body={
        'dateRanges': [{'startDate': '7daysAgo', 'endDate': 'today'}],
        'dimensions': [{'name': 'sessionDefaultChannelGroup'}],
        'metrics': [{'name': 'sessions'}],
        'orderBys': [{'metric': {'metricName': 'sessions'}, 'desc': True}],
        'limit': 5
    }).execute()

    sources = []
    for row in sources_resp.get('rows', []):
        sources.append({
            'channel': row['dimensionValues'][0]['value'],
            'sessions': int(row['metricValues'][0]['value'])
        })

    # Device breakdown (mobile/desktop/tablet)
    device_resp = api.properties().runReport(property=PROPERTY, body={
        'dateRanges': [{'startDate': '7daysAgo', 'endDate': 'today'}],
        'dimensions': [{'name': 'deviceCategory'}],
        'metrics': [{'name': 'sessions'}],
        'orderBys': [{'metric': {'metricName': 'sessions'}, 'desc': True}]
    }).execute()

    devices = []
    total_device_sessions = 0
    for row in device_resp.get('rows', []):
        s = int(row['metricValues'][0]['value'])
        total_device_sessions += s
        devices.append({'device': row['dimensionValues'][0]['value'], 'sessions': s})
    # Add percentage
    for d in devices:
        d['pct'] = round(d['sessions'] / total_device_sessions * 100) if total_device_sessions > 0 else 0

    # Daily trend (last 7 days)
    daily_resp = api.properties().runReport(property=PROPERTY, body={
        'dateRanges': [{'startDate': '7daysAgo', 'endDate': 'today'}],
        'dimensions': [{'name': 'date'}],
        'metrics': [{'name': 'sessions'}, {'name': 'screenPageViews'}, {'name': 'totalUsers'}],
        'orderBys': [{'dimension': {'dimensionName': 'date'}, 'desc': False}]
    }).execute()

    daily = []
    for row in daily_resp.get('rows', []):
        d = row['dimensionValues'][0]['value']
        daily.append({
            'date': f"{d[:4]}-{d[4:6]}-{d[6:]}",
            'sessions': int(row['metricValues'][0]['value']),
            'pageviews': int(row['metricValues'][1]['value']),
            'users': int(row['metricValues'][2]['value'])
        })

    # Build cache
    cache = {
        'updated': datetime.now().isoformat(),
        'property': 'theveteransconsultant.com',
        'thisWeek': tw,
        'lastWeek': lw,
        'deltas': deltas,
        'topPages': top_pages,
        'sources': sources,
        'devices': devices,
        'daily': daily
    }

    with open(CACHE_PATH, 'w') as f:
        json.dump(cache, f, indent=2)

    log(f"GA4 pull complete. Sessions: {tw.get('sessions',0)} (delta: {deltas.get('sessions',0)}%)")
    print(json.dumps(cache, indent=2))

if __name__ == '__main__':
    pull()
