import 'reflect-metadata';
import 'dotenv/config';
import Database from '@/common/lib/database';
import UserRepositoryImpl from '@/modules/user/user.repository';

const USER_ID = parseInt(process.argv[2], 10);
if (!USER_ID) {
  console.error('Usage: ts-node scripts/hard-delete-user.ts <user_id>');
  process.exit(1);
}

async function main() {
  const db = new Database();
  const userRepository = new UserRepositoryImpl(db);

  try {
    const user = await userRepository.findById(USER_ID);
    if (!user) {
      console.error(`No user found with id=${USER_ID}`);
      process.exit(1);
    }
    console.log(`Deleting user id=${user.id} (${user.email})...`);
    await userRepository.hardDeleteUser(USER_ID);
    console.log('Done — user and all cascading data removed.');
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
