import { getApp, getApps, initializeApp } from '@firebase/app';
import { getAuth } from '@firebase/auth';
import { getDatabase } from '@firebase/database';
import { OWNER_UID } from '../shared/owner.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBtVXFRyYRfKtJOtDAmFDbLpV73t8Lzvm0',
  authDomain: 'dep-lidar-scan.firebaseapp.com',
  databaseURL: 'https://dep-lidar-scan-default-rtdb.firebaseio.com',
  projectId: 'dep-lidar-scan',
  storageBucket: 'dep-lidar-scan.firebasestorage.app',
  messagingSenderId: '448096161874',
  appId: '1:448096161874:web:72ca37f5feb7df2e0acf8b',
};

export { OWNER_UID };
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
export const firebaseDatabase = getDatabase(app);
