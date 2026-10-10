-- MySQL dump 10.19  Distrib 10.3.39-MariaDB, for Linux (x86_64)
--
-- Host: localhost    Database: root_cwp
-- ------------------------------------------------------
-- Server version	10.3.39-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `backups`
--

DROP TABLE IF EXISTS `backups`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `backups` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `backup_enable` varchar(5) NOT NULL,
  `backup_location` varchar(60) NOT NULL,
  `backup_daily` varchar(5) NOT NULL,
  `backup_weekly` varchar(5) NOT NULL,
  `backup_monthly` varchar(5) NOT NULL,
  `backup_mysql` varchar(5) NOT NULL,
  `backup_vmail` varchar(5) NOT NULL,
  `backup_all` varchar(5) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `domains`
--

DROP TABLE IF EXISTS `domains`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `domains` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `domain` varchar(255) NOT NULL,
  `user` varchar(40) NOT NULL,
  `path` varchar(255) NOT NULL,
  `setup_time` datetime NOT NULL DEFAULT '2000-01-01 00:00:00',
  PRIMARY KEY (`id`)
) ENGINE=MyISAM AUTO_INCREMENT=10 DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `nameserver`
--

DROP TABLE IF EXISTS `nameserver`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `nameserver` (
  `id` int(40) NOT NULL,
  `ns1_name` varchar(255) NOT NULL,
  `ns1_ip` varchar(50) NOT NULL,
  `ns2_name` varchar(255) NOT NULL,
  `ns2_ip` varchar(50) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `notifications`
--

DROP TABLE IF EXISTS `notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user` varchar(255) NOT NULL,
  `shortjob` text NOT NULL,
  `description` text NOT NULL,
  `link` varchar(255) NOT NULL,
  `readed` varchar(255) NOT NULL,
  `completed` varchar(255) NOT NULL,
  `date` datetime NOT NULL DEFAULT '2000-01-01 00:00:00',
  PRIMARY KEY (`id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `packages`
--

DROP TABLE IF EXISTS `packages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `packages` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `package_name` varchar(255) NOT NULL,
  `disk_quota` varchar(40) NOT NULL,
  `bandwidth` varchar(40) NOT NULL,
  `ftp_accounts` varchar(40) NOT NULL,
  `email_accounts` varchar(40) NOT NULL,
  `email_lists` varchar(40) NOT NULL,
  `databases` varchar(40) NOT NULL,
  `sub_domains` varchar(40) NOT NULL,
  `parked_domains` varchar(40) NOT NULL,
  `addons_domains` varchar(40) NOT NULL,
  `hourly_emails` varchar(40) NOT NULL,
  `reseller` varchar(40) NOT NULL,
  `accounts` varchar(40) NOT NULL,
  `cgroups` varchar(255) DEFAULT NULL,
  `nproc` varchar(40) NOT NULL DEFAULT '40',
  `apache_nproc` varchar(40) NOT NULL DEFAULT '40',
  `inode` varchar(40) NOT NULL DEFAULT '0',
  `nofile` varchar(40) NOT NULL DEFAULT '150',
  PRIMARY KEY (`id`)
) ENGINE=MyISAM AUTO_INCREMENT=3 DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `settings`
--

DROP TABLE IF EXISTS `settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `settings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `login_type` varchar(40) NOT NULL,
  `ssh_port` varchar(40) NOT NULL,
  `root_name` varchar(7) NOT NULL,
  `root_email` varchar(255) NOT NULL,
  `apache_port` varchar(5) NOT NULL,
  `homedir` varchar(200) NOT NULL,
  `mysql_pwd` varchar(40) NOT NULL,
  `apache_vhost_tpl` text NOT NULL,
  `apache_sub_vhost_tpl` text NOT NULL,
  `named_tpl` text NOT NULL,
  `dns_zone_tpl` text NOT NULL,
  `shared_ip` varchar(50) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=MyISAM AUTO_INCREMENT=2 DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `subdomains`
--

DROP TABLE IF EXISTS `subdomains`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `subdomains` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `subdomain` varchar(255) NOT NULL,
  `domain` varchar(255) NOT NULL,
  `user` varchar(40) NOT NULL,
  `path` varchar(255) NOT NULL,
  `setup_time` datetime NOT NULL DEFAULT '2000-01-01 00:00:00',
  PRIMARY KEY (`id`)
) ENGINE=MyISAM AUTO_INCREMENT=92 DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user`
--

DROP TABLE IF EXISTS `user`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `user` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(40) NOT NULL,
  `domain` varchar(255) NOT NULL,
  `ip_address` varchar(50) NOT NULL,
  `email` varchar(255) NOT NULL,
  `setup_date` datetime NOT NULL DEFAULT '2000-01-01 00:00:00',
  `package` varchar(40) NOT NULL,
  `backup` varchar(40) NOT NULL,
  `reseller` varchar(40) NOT NULL,
  `last_access` datetime NOT NULL DEFAULT '2000-01-01 00:00:00',
  `bandwidth` varchar(40) NOT NULL DEFAULT '0',
  `mail_disk` int(11) NOT NULL DEFAULT 0,
  `mysql_disk` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=MyISAM AUTO_INCREMENT=20 DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping routines for database 'root_cwp'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
